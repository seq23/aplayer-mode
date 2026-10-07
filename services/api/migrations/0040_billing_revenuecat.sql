-- 0040: Phase D billing — App Store + Google Play subscriptions via RevenueCat
-- (docs/33-BILLING-PHASE-D.md, ADR-0004 monthly prices, ADR-0005 annual plans).
--
-- Trust model:
--   * public.subscription_entitlements is the ONLY entitlement the app and API trust.
--     Nothing a client sends can write it: direct table writes are revoked from anon and
--     authenticated, and every billing function is service-role only.
--   * The single writer is private.apm_billing_apply_event, called by the Worker's
--     RevenueCat webhook AFTER it verified the webhook Authorization secret. It is
--     idempotent on the RevenueCat event id, ignores out-of-order (stale) events, maps a
--     product id to a plan ONLY through private.billing_products (never through the
--     event's own entitlement list), and audits every applied change.
--   * Founding 100 eligibility is decided here, atomically (one advisory lock, 100 slot
--     numbers as primary keys, so a 101st slot cannot exist). The client never decides.
--   * Buying a tier never grants autonomy: nothing here touches public.permissions.
--     Authority stays min(entitlement, user permission, server policy, kill switch).

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------------------
-- 1. Entitlement row: store detail, and no client writes
-- ---------------------------------------------------------------------------

alter table public.subscription_entitlements
  add column if not exists billing_period text,
  add column if not exists store_product_id text,
  add column if not exists offer text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists billing_issue_at timestamptz,
  add column if not exists pending_plan text,
  add column if not exists last_event_at timestamptz;

alter table public.subscription_entitlements
  add constraint subscription_entitlements_billing_period_check check (billing_period is null or billing_period in ('monthly','annual')),
  add constraint subscription_entitlements_offer_check check (offer is null or offer in ('standard','founding')),
  add constraint subscription_entitlements_pending_plan_check check (pending_plan is null or pending_plan in ('chief_of_staff','life_os','autopilot')),
  add constraint subscription_entitlements_provider_check check (provider is null or provider in ('app_store','google_play')) not valid;

revoke all on table public.subscription_entitlements from anon;
revoke insert, update, delete, truncate, references, trigger on table public.subscription_entitlements from authenticated;
grant select on table public.subscription_entitlements to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Server-side tables (private schema: not exposed through PostgREST)
-- ---------------------------------------------------------------------------

-- The store catalogue. Mirrors BILLING_PRODUCTS in packages/policy/src/index.ts
-- (pinned by services/api/test/billing-db.test.mjs).
create table private.billing_products (
  product_id text primary key,
  store text not null check (store in ('app_store','google_play')),
  plan text not null check (plan in ('chief_of_staff','life_os','autopilot')),
  billing_period text not null check (billing_period in ('monthly','annual')),
  offer text not null check (offer in ('standard','founding')),
  check (offer = 'standard' or (plan = 'chief_of_staff' and billing_period = 'monthly'))
);

insert into private.billing_products (product_id, store, plan, billing_period, offer) values
  ('apm_cos_monthly', 'app_store', 'chief_of_staff', 'monthly', 'standard'),
  ('apm_cos_monthly_founding', 'app_store', 'chief_of_staff', 'monthly', 'founding'),
  ('apm_cos_annual', 'app_store', 'chief_of_staff', 'annual', 'standard'),
  ('apm_lifeos_monthly', 'app_store', 'life_os', 'monthly', 'standard'),
  ('apm_lifeos_annual', 'app_store', 'life_os', 'annual', 'standard'),
  ('apm_autopilot_monthly', 'app_store', 'autopilot', 'monthly', 'standard'),
  ('apm_autopilot_annual', 'app_store', 'autopilot', 'annual', 'standard'),
  ('apm_cos:monthly', 'google_play', 'chief_of_staff', 'monthly', 'standard'),
  ('apm_cos:founding-monthly', 'google_play', 'chief_of_staff', 'monthly', 'founding'),
  ('apm_cos:annual', 'google_play', 'chief_of_staff', 'annual', 'standard'),
  ('apm_lifeos:monthly', 'google_play', 'life_os', 'monthly', 'standard'),
  ('apm_lifeos:annual', 'google_play', 'life_os', 'annual', 'standard'),
  ('apm_autopilot:monthly', 'google_play', 'autopilot', 'monthly', 'standard'),
  ('apm_autopilot:annual', 'google_play', 'autopilot', 'annual', 'standard');

-- One row per RevenueCat event id: the idempotency key and the receipt of what was done.
-- Minimal by design: no raw payload, no subscriber attributes (they can carry PII).
create table private.billing_events (
  event_id text primary key check (char_length(event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 64),
  app_user_id text check (app_user_id is null or char_length(app_user_id) <= 200),
  user_id uuid references auth.users(id) on delete set null,
  product_id text check (product_id is null or char_length(product_id) <= 200),
  store text check (store is null or char_length(store) <= 40),
  environment text check (environment is null or char_length(environment) <= 40),
  event_at timestamptz,
  expiration_at timestamptz,
  outcome text not null,
  received_at timestamptz not null default now()
);
create index billing_events_user_idx on private.billing_events(user_id, received_at desc);

-- Founding 100: slot numbers 1..100 ARE the primary key, so a 101st slot cannot exist.
-- reserved = offered to this user (expires); claimed = a verified founding purchase;
-- lapsed = the lock was lost (expiry, refund, or moving off the founding product).
-- Claimed and lapsed slots stay consumed: "the first 100 subscribers".
create table private.billing_founding_slots (
  slot_no smallint primary key check (slot_no between 1 and 100),
  user_id uuid unique references auth.users(id) on delete set null,
  status text not null check (status in ('reserved','claimed','lapsed')),
  reserved_until timestamptz,
  claimed_at timestamptz,
  lapsed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table private.billing_products enable row level security;
alter table private.billing_events enable row level security;
alter table private.billing_founding_slots enable row level security;
revoke all on table private.billing_products from public, anon, authenticated;
revoke all on table private.billing_events from public, anon, authenticated;
revoke all on table private.billing_founding_slots from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

create or replace function private.apm_billing_plan_rank(p_plan text)
returns integer
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_plan when 'chief_of_staff' then 1 when 'life_os' then 2 when 'autopilot' then 3 else 0 end;
$$;

create or replace function private.apm_billing_audit(p_user_id uuid, p_event_type text, p_metadata jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, data_class, metadata)
  values (p_user_id, p_event_type, 'system', 'revenuecat', 'subscription_entitlement', p_user_id::text, 'billing', coalesce(p_metadata, '{}'::jsonb));
$$;

-- Ends a user's Founding 100 lock (expiry, refund, or moving off the founding product).
create or replace function private.apm_billing_lapse_founding(p_user_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.billing_founding_slots
     set status = 'lapsed', lapsed_at = now(), reserved_until = null, updated_at = now()
   where user_id = p_user_id and status = 'claimed';
  if found then
    perform private.apm_billing_audit(p_user_id, 'billing.founding_lapsed', jsonb_build_object('reason', p_reason));
  end if;
  -- An unused reservation is released so the slot can go to someone else.
  delete from private.billing_founding_slots where user_id = p_user_id and status = 'reserved';
end;
$$;

-- Claims a Founding 100 slot for a verified founding purchase. Returns true when the
-- user holds a claimed slot afterwards. Caller holds the founding advisory lock.
create or replace function private.apm_billing_claim_founding(p_user_id uuid, p_now timestamptz)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot private.billing_founding_slots;
  v_free smallint;
begin
  select * into v_slot from private.billing_founding_slots s where s.user_id = p_user_id for update;
  if v_slot.slot_no is not null then
    if v_slot.status = 'lapsed' then
      return false; -- a lapse loses the lock for good
    end if;
    update private.billing_founding_slots
       set status = 'claimed', claimed_at = coalesce(claimed_at, p_now), reserved_until = null, updated_at = now()
     where slot_no = v_slot.slot_no;
    return true;
  end if;
  -- No reservation (it expired, or the purchase came from outside the app): claim a
  -- slot only if one is free right now.
  select s.slot_no into v_free from private.billing_founding_slots s
   where s.status = 'reserved' and s.reserved_until < p_now
   order by s.slot_no limit 1 for update;
  if v_free is not null then
    update private.billing_founding_slots
       set user_id = p_user_id, status = 'claimed', claimed_at = p_now, reserved_until = null, lapsed_at = null, updated_at = now()
     where slot_no = v_free;
    return true;
  end if;
  select min(n)::smallint into v_free from generate_series(1, 100) as n
   where not exists (select 1 from private.billing_founding_slots s where s.slot_no = n);
  if v_free is null then
    return false;
  end if;
  insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at)
  values (v_free, p_user_id, 'claimed', p_now);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Which offering the app may show (the server decides Founding 100)
-- ---------------------------------------------------------------------------

create or replace function private.apm_billing_offering(p_user_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot private.billing_founding_slots;
  v_ent public.subscription_entitlements;
  v_free smallint;
  v_until timestamptz := p_now + interval '60 minutes';
begin
  if p_user_id is null or p_now is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'billing_unknown_user' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtext('apm_billing_founding_slots'));

  select * into v_slot from private.billing_founding_slots s where s.user_id = p_user_id;
  if v_slot.slot_no is not null then
    if v_slot.status = 'claimed' then
      return jsonb_build_object('offering', 'founding', 'founding', true, 'reservedUntil', null);
    elsif v_slot.status = 'reserved' and v_slot.reserved_until >= p_now then
      update private.billing_founding_slots set reserved_until = v_until, updated_at = now() where slot_no = v_slot.slot_no;
      return jsonb_build_object('offering', 'founding', 'founding', false, 'reservedUntil', v_until);
    elsif v_slot.status = 'lapsed' then
      return jsonb_build_object('offering', 'default', 'founding', false, 'reservedUntil', null);
    end if;
    -- An expired reservation of this user's own: drop it and decide afresh below.
    delete from private.billing_founding_slots where slot_no = v_slot.slot_no;
  end if;

  -- "The first 100 subscribers": anyone who has already held a store subscription is not one.
  select * into v_ent from public.subscription_entitlements e where e.user_id = p_user_id;
  if v_ent.provider is not null or exists (
    select 1 from private.billing_events be where be.user_id = p_user_id and be.outcome = 'applied'
  ) then
    return jsonb_build_object('offering', 'default', 'founding', false, 'reservedUntil', null);
  end if;

  select s.slot_no into v_free from private.billing_founding_slots s
   where s.status = 'reserved' and s.reserved_until < p_now
   order by s.slot_no limit 1;
  if v_free is not null then
    update private.billing_founding_slots
       set user_id = p_user_id, reserved_until = v_until, claimed_at = null, lapsed_at = null, updated_at = now()
     where slot_no = v_free;
  else
    select min(n)::smallint into v_free from generate_series(1, 100) as n
     where not exists (select 1 from private.billing_founding_slots s where s.slot_no = n);
    if v_free is null then
      return jsonb_build_object('offering', 'default', 'founding', false, 'reservedUntil', null);
    end if;
    insert into private.billing_founding_slots (slot_no, user_id, status, reserved_until)
    values (v_free, p_user_id, 'reserved', v_until);
  end if;
  return jsonb_build_object('offering', 'founding', 'founding', false, 'reservedUntil', v_until);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The webhook writer
-- ---------------------------------------------------------------------------

create or replace function private.apm_billing_apply_event(p_event jsonb, p_allow_sandbox boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_id text;
  v_type text;
  v_app_user text;
  v_user uuid;
  v_store text;
  v_env text;
  v_event_at timestamptz;
  v_exp timestamptz;
  v_product private.billing_products;
  v_new private.billing_products;
  v_ent public.subscription_entitlements;
  v_outcome text;
  v_existing text;
  v_founding boolean;
  v_offer text;
  v_status text;
  v_now timestamptz := now();
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'billing_invalid_event' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_event) loop
    if v_key not in ('id','type','app_user_id','product_id','new_product_id','store','environment',
                     'event_timestamp_ms','expiration_at_ms','cancel_reason','period_type') then
      raise exception 'billing_invalid_event' using errcode = '22023';
    end if;
  end loop;
  for v_key in select k from unnest(array['id','type','app_user_id','product_id','new_product_id','store','environment','cancel_reason','period_type']) k loop
    if p_event ? v_key and jsonb_typeof(p_event->v_key) not in ('string','null') then
      raise exception 'billing_invalid_event' using errcode = '22023';
    end if;
  end loop;
  for v_key in select k from unnest(array['event_timestamp_ms','expiration_at_ms']) k loop
    if p_event ? v_key and jsonb_typeof(p_event->v_key) not in ('number','null') then
      raise exception 'billing_invalid_event' using errcode = '22023';
    end if;
  end loop;

  v_id := p_event->>'id';
  v_type := p_event->>'type';
  if v_id is null or char_length(v_id) not between 1 and 200 or v_type is null or v_type !~ '^[A-Z_]{1,64}$' then
    raise exception 'billing_invalid_event' using errcode = '22023';
  end if;
  if p_event->>'event_timestamp_ms' is null then
    raise exception 'billing_invalid_event' using errcode = '22023';
  end if;
  v_event_at := to_timestamp((p_event->>'event_timestamp_ms')::numeric / 1000.0);
  v_exp := case when p_event->>'expiration_at_ms' is null then null else to_timestamp((p_event->>'expiration_at_ms')::numeric / 1000.0) end;
  v_app_user := left(p_event->>'app_user_id', 200);
  v_store := left(p_event->>'store', 40);
  v_env := left(p_event->>'environment', 40);
  if v_app_user ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select u.id into v_user from auth.users u where u.id = v_app_user::uuid;
  end if;

  -- Idempotency: the first delivery of an event id wins; a replay changes nothing.
  insert into private.billing_events (event_id, event_type, app_user_id, user_id, product_id, store, environment, event_at, expiration_at, outcome)
  values (v_id, v_type, v_app_user, v_user, left(p_event->>'product_id', 200), v_store, v_env, v_event_at, v_exp, 'processing')
  on conflict (event_id) do nothing;
  if not found then
    select be.outcome into v_existing from private.billing_events be where be.event_id = v_id;
    return jsonb_build_object('outcome', v_existing, 'replayed', true);
  end if;

  if v_type = 'TEST' then
    v_outcome := 'ignored_test';
  elsif v_env is distinct from 'PRODUCTION' and not (coalesce(p_allow_sandbox, false) and v_env = 'SANDBOX') then
    v_outcome := 'ignored_environment';
  elsif v_user is null then
    v_outcome := 'ignored_unknown_user';
  elsif v_type not in ('INITIAL_PURCHASE','RENEWAL','UNCANCELLATION','SUBSCRIPTION_EXTENDED','PRODUCT_CHANGE',
                       'CANCELLATION','BILLING_ISSUE','EXPIRATION','REFUND','REFUND_REVERSED') then
    v_outcome := 'ignored_unhandled_type';
  else
    select * into v_product from private.billing_products bp
     where bp.product_id = p_event->>'product_id'
       and bp.store = case v_store when 'APP_STORE' then 'app_store' when 'PLAY_STORE' then 'google_play' end;
    if v_product.product_id is null then
      v_outcome := 'ignored_unknown_product';
    end if;
  end if;

  if v_outcome is not null then
    update private.billing_events set outcome = v_outcome where event_id = v_id;
    return jsonb_build_object('outcome', v_outcome, 'replayed', false);
  end if;

  -- One lock order everywhere (founding advisory lock, then the entitlement row), so
  -- the webhook, the offering and the sweep can never deadlock each other.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('apm_billing_founding_slots'));
  insert into public.subscription_entitlements (user_id, plan, status) values (v_user, 'beta', 'active') on conflict (user_id) do nothing;
  select * into v_ent from public.subscription_entitlements e where e.user_id = v_user for update;

  -- Out-of-order delivery: never let an older event overwrite a newer state.
  if v_ent.last_event_at is not null and v_event_at < v_ent.last_event_at then
    update private.billing_events set outcome = 'stale' where event_id = v_id;
    return jsonb_build_object('outcome', 'stale', 'replayed', false);
  end if;

  -- Events about a product the user is no longer on (after a crossgrade, say) change nothing.
  if v_type in ('CANCELLATION','BILLING_ISSUE','EXPIRATION','REFUND','PRODUCT_CHANGE','UNCANCELLATION','SUBSCRIPTION_EXTENDED')
     and v_ent.store_product_id is distinct from v_product.product_id then
    update private.billing_events set outcome = 'ignored_other_product' where event_id = v_id;
    return jsonb_build_object('outcome', 'ignored_other_product', 'replayed', false);
  end if;

  v_outcome := 'applied';

  if v_type in ('INITIAL_PURCHASE','RENEWAL','UNCANCELLATION','SUBSCRIPTION_EXTENDED','REFUND_REVERSED') then
    if v_exp is null then
      raise exception 'billing_invalid_event' using errcode = '22023';
    end if;
    v_offer := 'standard';
    if v_product.offer = 'founding' then
      v_founding := private.apm_billing_claim_founding(v_user, v_event_at);
      if v_founding then
        v_offer := 'founding';
      else
        -- The store already charged the founding price; access is honoured, but the lock
        -- is not granted and the mismatch is on the record for review.
        perform private.apm_billing_audit(v_user, 'billing.founding_without_slot', jsonb_build_object('productId', v_product.product_id, 'eventId', v_id));
      end if;
    else
      perform private.apm_billing_lapse_founding(v_user, 'moved_off_founding_product');
    end if;
    v_status := case when v_exp > v_now then 'active' else 'expired' end;
    update public.subscription_entitlements set
      plan = v_product.plan,
      status = v_status,
      provider = v_product.store,
      external_customer_id = v_user::text,
      external_entitlement_id = v_product.plan,
      store_product_id = v_product.product_id,
      billing_period = v_product.billing_period,
      offer = v_offer,
      current_period_end = v_exp,
      cancel_at_period_end = case when v_type = 'SUBSCRIPTION_EXTENDED' then cancel_at_period_end else false end,
      billing_issue_at = null,
      pending_plan = case when pending_plan = v_product.plan then null else pending_plan end,
      last_event_at = v_event_at,
      updated_at = now()
    where user_id = v_user;
    if v_status = 'expired' then
      perform private.apm_billing_lapse_founding(v_user, 'expired');
    end if;

  elsif v_type = 'PRODUCT_CHANGE' then
    select * into v_new from private.billing_products bp
     where bp.product_id = p_event->>'new_product_id' and bp.store = v_product.store;
    if v_new.product_id is null then
      v_outcome := 'ignored_unknown_product';
    elsif private.apm_billing_plan_rank(v_new.plan) > private.apm_billing_plan_rank(v_ent.plan) and v_ent.status = 'active' then
      -- Upgrade: the store charges (prorated) now, so the higher tier starts now.
      perform private.apm_billing_lapse_founding(v_user, 'moved_off_founding_product');
      update public.subscription_entitlements set
        plan = v_new.plan, store_product_id = v_new.product_id, billing_period = v_new.billing_period,
        offer = 'standard', pending_plan = null, cancel_at_period_end = false,
        current_period_end = coalesce(v_exp, current_period_end),
        last_event_at = v_event_at, updated_at = now()
      where user_id = v_user;
    else
      -- Downgrade or period change: takes effect at renewal (the RENEWAL event carries the
      -- new product). Until then the paid-for tier stays.
      update public.subscription_entitlements set pending_plan = v_new.plan, last_event_at = v_event_at, updated_at = now()
      where user_id = v_user;
    end if;

  elsif v_type = 'CANCELLATION' and coalesce(p_event->>'cancel_reason', '') <> 'CUSTOMER_SUPPORT' then
    -- Auto-renew turned off: access continues to the end of the paid period.
    update public.subscription_entitlements set
      cancel_at_period_end = true,
      current_period_end = coalesce(v_exp, current_period_end),
      last_event_at = v_event_at, updated_at = now()
    where user_id = v_user;

  elsif v_type in ('REFUND','CANCELLATION') then
    -- Refund (RevenueCat reports refunds as CANCELLATION with cancel_reason CUSTOMER_SUPPORT):
    -- access ends now and a founding lock is lost.
    update public.subscription_entitlements set
      status = 'expired', cancel_at_period_end = false, pending_plan = null,
      current_period_end = least(coalesce(current_period_end, v_now), v_now),
      last_event_at = v_event_at, updated_at = now()
    where user_id = v_user;
    perform private.apm_billing_lapse_founding(v_user, 'refunded');
    v_type := 'REFUND';

  elsif v_type = 'BILLING_ISSUE' then
    -- With a store grace period RevenueCat moves expiration to the end of grace: access
    -- continues until then. Without one, the subscription is on hold: no access.
    update public.subscription_entitlements set
      status = case when v_exp is not null and v_exp > v_now then 'active' else 'past_due' end,
      billing_issue_at = v_event_at,
      current_period_end = coalesce(v_exp, current_period_end),
      last_event_at = v_event_at, updated_at = now()
    where user_id = v_user;

  elsif v_type = 'EXPIRATION' then
    update public.subscription_entitlements set
      status = 'expired', cancel_at_period_end = false, pending_plan = null,
      current_period_end = coalesce(v_exp, current_period_end),
      last_event_at = v_event_at, updated_at = now()
    where user_id = v_user;
    perform private.apm_billing_lapse_founding(v_user, 'expired');
  end if;

  update private.billing_events set outcome = v_outcome where event_id = v_id;
  if v_outcome = 'applied' then
    select * into v_ent from public.subscription_entitlements e where e.user_id = v_user;
    perform private.apm_billing_audit(v_user, 'billing.' || lower(v_type), jsonb_build_object(
      'eventId', v_id, 'productId', v_product.product_id, 'plan', v_ent.plan, 'status', v_ent.status,
      'offer', v_ent.offer, 'periodEnd', v_ent.current_period_end, 'cancelAtPeriodEnd', v_ent.cancel_at_period_end));
  end if;
  return jsonb_build_object('outcome', v_outcome, 'replayed', false, 'plan', v_ent.plan, 'status', v_ent.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Safety net: a store entitlement past its period end (plus a day for a delayed
--    RENEWAL webhook) expires even if the EXPIRATION webhook never arrives. A later
--    RENEWAL is newer than the last applied event and restores it.
-- ---------------------------------------------------------------------------

create or replace function private.apm_billing_expire_lapsed(p_now timestamptz)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if p_now is null then
    raise exception 'billing_invalid_request' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtext('apm_billing_founding_slots'));
  for v_row in
    update public.subscription_entitlements e
       set status = 'expired', cancel_at_period_end = false, pending_plan = null, updated_at = now()
     where e.provider in ('app_store','google_play')
       and e.status in ('active','trialing','past_due')
       and e.current_period_end is not null
       and e.current_period_end < p_now - interval '1 day'
    returning e.user_id, e.plan
  loop
    v_count := v_count + 1;
    perform private.apm_billing_lapse_founding(v_row.user_id, 'expired');
    perform private.apm_billing_audit(v_row.user_id, 'billing.expired_by_sweep', jsonb_build_object('plan', v_row.plan));
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RPC surface: SECURITY INVOKER wrappers, service role only
-- ---------------------------------------------------------------------------

create or replace function public.apm_service_billing_apply_event(p_event jsonb, p_allow_sandbox boolean)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_billing_apply_event(p_event, p_allow_sandbox); $$;
create or replace function public.apm_service_billing_offering(p_user_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_billing_offering(p_user_id, now()); $$;
create or replace function public.apm_service_billing_expire_lapsed()
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.apm_billing_expire_lapsed(now()); $$;

revoke all on function private.apm_billing_plan_rank(text) from public, anon, authenticated;
revoke all on function private.apm_billing_audit(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_billing_lapse_founding(uuid, text) from public, anon, authenticated;
revoke all on function private.apm_billing_claim_founding(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.apm_billing_offering(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.apm_billing_apply_event(jsonb, boolean) from public, anon, authenticated;
revoke all on function private.apm_billing_expire_lapsed(timestamptz) from public, anon, authenticated;
revoke all on function public.apm_service_billing_apply_event(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.apm_service_billing_offering(uuid) from public, anon, authenticated;
revoke all on function public.apm_service_billing_expire_lapsed() from public, anon, authenticated;

grant execute on function private.apm_billing_offering(uuid, timestamptz) to service_role;
grant execute on function private.apm_billing_apply_event(jsonb, boolean) to service_role;
grant execute on function private.apm_billing_expire_lapsed(timestamptz) to service_role;
grant execute on function public.apm_service_billing_apply_event(jsonb, boolean) to service_role;
grant execute on function public.apm_service_billing_offering(uuid) to service_role;
grant execute on function public.apm_service_billing_expire_lapsed() to service_role;
