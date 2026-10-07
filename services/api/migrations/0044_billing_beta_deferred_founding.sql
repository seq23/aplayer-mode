-- 0044: billing entitlements (backend review, 7 Oct 2026: db P1-5, P2-1, P2-2).
--
--  A. Beta is no longer a permanent free plan for every account. Beta access is an
--     explicit allowlist entry with an end date (private.beta_allowlist), granted by the
--     operator with apm_service_beta_grant. It applies only to an account that has never
--     held a store subscription: a paid or lapsed state always governs. A new account
--     that is not allowlisted starts with no access (plan 'beta', status 'expired').
--     Accounts that exist before this migration are grandfathered on the allowlist
--     until 2027-01-31 (explicit end date, recorded with a note), so current testers
--     are not locked out mid-beta.
--  B. A refund / cancellation / expiration delivered before its purchase is 'deferred',
--     not dropped, and takes effect when the purchase lands.
--  C. Founding 100: only paid, active founding subscriptions hold a slot. Viewing the
--     paywall reserves nothing; a lapse frees the slot for someone else and the lapsed
--     account is remembered so it can never take the lock again.

-- ---------------------------------------------------------------- A. beta
create table private.beta_allowlist (
  email text primary key check (email = lower(btrim(email)) and char_length(email) between 3 and 320),
  granted_until timestamptz not null,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);
alter table private.beta_allowlist enable row level security;
create policy beta_allowlist_server_only on private.beta_allowlist for all to anon, authenticated using (false) with check (false);
revoke all on table private.beta_allowlist from public, anon, authenticated;

create or replace function private.apm_beta_until(p_email text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select b.granted_until from private.beta_allowlist b where b.email = lower(btrim(coalesce(p_email, ''))) and b.granted_until > now();
$$;
revoke all on function private.apm_beta_until(text) from public, anon, authenticated;

-- Grandfather the accounts that exist now: a bounded beta, never permanent.
insert into private.beta_allowlist (email, granted_until, note)
select distinct lower(btrim(u.email)), '2027-01-31T00:00:00Z'::timestamptz, 'grandfathered by 0044 (pre-allowlist beta account)'
  from auth.users u
  join public.subscription_entitlements e on e.user_id = u.id
 where u.email is not null and char_length(btrim(u.email)) between 3 and 320
   and e.plan = 'beta' and e.provider is null
on conflict (email) do nothing;

-- Every never-paid beta row now carries its end date; rows with no allowlist entry end now.
update public.subscription_entitlements e set
  status = case when private.apm_beta_until(u.email) is not null then 'active' else 'expired' end,
  current_period_end = coalesce(private.apm_beta_until(u.email), least(coalesce(e.current_period_end, now()), now())),
  updated_at = now()
  from auth.users u
 where u.id = e.user_id and e.plan = 'beta' and e.provider is null;
update public.subscription_entitlements e set status = 'expired', current_period_end = least(coalesce(e.current_period_end, now()), now()), updated_at = now()
 where e.plan = 'beta' and e.provider is null and not exists (select 1 from auth.users u where u.id = e.user_id and u.email is not null);

create or replace function public.apm_initialize_user_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_until timestamptz := private.apm_beta_until(new.email);
begin
  insert into public.notification_preferences(user_id) values (new.id) on conflict do nothing;
  insert into public.subscription_entitlements(user_id, plan, status, current_period_end)
  values (new.id, 'beta', case when v_until is not null then 'active' else 'expired' end, v_until)
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.apm_initialize_user_defaults() from public, anon, authenticated;

-- Core access: a paid plan that is active, or an allowlisted beta that has not ended
-- and was never superseded by a store subscription.
create or replace function private.apm_has_core_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscription_entitlements se
     where se.user_id = p_user_id
       and se.status in ('active','trialing')
       and (se.plan in ('chief_of_staff','life_os','autopilot')
            or (se.plan = 'beta' and se.provider is null and se.current_period_end is not null and se.current_period_end > now()))
  );
$$;

-- Operator grant (service role only): allowlist an email until a date at most a year out.
create or replace function private.apm_service_beta_grant(p_email text, p_until timestamptz, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user uuid;
begin
  if p_until is null or p_until <= now() or p_until > now() + interval '366 days' or char_length(v_email) not between 3 and 320 then
    raise exception 'billing_invalid_request' using errcode = '22023';
  end if;
  insert into private.beta_allowlist (email, granted_until, note) values (v_email, p_until, left(p_note, 200))
  on conflict (email) do update set granted_until = excluded.granted_until, note = excluded.note;
  select u.id into v_user from auth.users u where lower(btrim(u.email)) = v_email;
  if v_user is not null then
    -- Never over a store subscription, paid or lapsed.
    update public.subscription_entitlements set status = 'active', current_period_end = p_until, updated_at = now()
     where user_id = v_user and plan = 'beta' and provider is null;
  end if;
  return jsonb_build_object('email', v_email, 'grantedUntil', p_until, 'userId', v_user);
end;
$$;
create or replace function public.apm_service_beta_grant(p_email text, p_until timestamptz, p_note text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_beta_grant(p_email, p_until, p_note); $$;
revoke all on function private.apm_service_beta_grant(text, timestamptz, text) from public, anon, authenticated;
grant execute on function private.apm_service_beta_grant(text, timestamptz, text) to service_role;
revoke all on function public.apm_service_beta_grant(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apm_service_beta_grant(text, timestamptz, text) to service_role;

-- The sweep also ends beta windows that have passed.
create or replace function private.apm_billing_expire_lapsed(p_now timestamptz)
returns integer
language plpgsql
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
  for v_row in
    update public.subscription_entitlements e
       set status = 'expired', updated_at = now()
     where e.plan = 'beta' and e.provider is null and e.status in ('active','trialing')
       and (e.current_period_end is null or e.current_period_end <= p_now)
    returning e.user_id
  loop
    v_count := v_count + 1;
    perform private.apm_billing_audit(v_row.user_id, 'billing.beta_ended', '{}'::jsonb);
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- B. deferred events
alter table private.billing_events add column cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 64);

-- ---------------------------------------------------------------- C. Founding 100
create table private.billing_founding_lapsed (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lapsed_at timestamptz not null default now(),
  reason text not null check (char_length(reason) <= 64)
);
alter table private.billing_founding_lapsed enable row level security;
create policy billing_founding_lapsed_server_only on private.billing_founding_lapsed for all to anon, authenticated using (false) with check (false);
revoke all on table private.billing_founding_lapsed from public, anon, authenticated;

insert into private.billing_founding_lapsed (user_id, lapsed_at, reason)
select s.user_id, coalesce(s.lapsed_at, now()), 'lapsed_before_0044' from private.billing_founding_slots s
 where s.status = 'lapsed' and s.user_id is not null
on conflict (user_id) do nothing;
-- Reservations and lapsed rows no longer hold a slot.
delete from private.billing_founding_slots where status in ('reserved','lapsed') or user_id is null;

create or replace function private.apm_billing_lapse_founding(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.billing_founding_slots where user_id = p_user_id and status = 'claimed';
  if found then
    insert into private.billing_founding_lapsed (user_id, reason) values (p_user_id, left(coalesce(p_reason, 'lapsed'), 64))
    on conflict (user_id) do nothing;
    perform private.apm_billing_audit(p_user_id, 'billing.founding_lapsed', jsonb_build_object('reason', p_reason));
  end if;
end;
$$;

-- Who may be offered / claim the founding price: never a former subscriber, never a
-- lapsed founder.
create or replace function private.apm_billing_founding_eligible(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.subscription_entitlements e where e.user_id = p_user_id and e.provider is not null)
     and not exists (select 1 from private.billing_events be where be.user_id = p_user_id and be.outcome in ('applied','applied_deferred'))
     and not exists (select 1 from private.billing_founding_lapsed l where l.user_id = p_user_id);
$$;
revoke all on function private.apm_billing_founding_eligible(uuid) from public, anon, authenticated;

-- The paywall: a read. It reserves nothing, so viewing it cannot hold a slot.
create or replace function private.apm_billing_offering(p_user_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_now is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'billing_unknown_user' using errcode = '22023';
  end if;
  if exists (select 1 from private.billing_founding_slots s where s.user_id = p_user_id and s.status = 'claimed') then
    return jsonb_build_object('offering', 'founding', 'founding', true, 'reservedUntil', null);
  end if;
  if private.apm_billing_founding_eligible(p_user_id)
     and (select count(*) from private.billing_founding_slots s where s.status = 'claimed') < 100 then
    return jsonb_build_object('offering', 'founding', 'founding', false, 'reservedUntil', null);
  end if;
  return jsonb_build_object('offering', 'default', 'founding', false, 'reservedUntil', null);
end;
$$;

-- The claim, on a paid founding purchase (under the founding advisory lock taken by
-- apply_event): the lowest free slot number, while fewer than 100 are held.
create or replace function private.apm_billing_claim_founding(p_user_id uuid, p_now timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_free smallint;
begin
  if exists (select 1 from private.billing_founding_slots s where s.user_id = p_user_id and s.status = 'claimed') then
    return true;
  end if;
  if not private.apm_billing_founding_eligible(p_user_id) then
    return false;
  end if;
  select min(n)::smallint into v_free from generate_series(1, 100) as n
   where not exists (select 1 from private.billing_founding_slots s where s.slot_no = n);
  if v_free is null then
    return false;
  end if;
  insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at) values (v_free, p_user_id, 'claimed', p_now);
  return true;
end;
$$;

alter table private.billing_founding_slots drop constraint if exists billing_founding_slots_status_check;
alter table private.billing_founding_slots add constraint billing_founding_slots_status_check check (status = 'claimed');
alter table private.billing_founding_slots alter column user_id set not null;

create or replace function private.apm_billing_apply_event(p_event jsonb, p_allow_sandbox boolean)
returns jsonb
language plpgsql
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
  v_def private.billing_events;
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
  insert into private.billing_events (event_id, event_type, app_user_id, user_id, product_id, store, environment, event_at, expiration_at, cancel_reason, outcome)
  values (v_id, v_type, v_app_user, v_user, left(p_event->>'product_id', 200), v_store, v_env, v_event_at, v_exp, left(p_event->>'cancel_reason', 64), 'processing')
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
  insert into public.subscription_entitlements (user_id, plan, status) values (v_user, 'beta', 'expired') on conflict (user_id) do nothing;
  select * into v_ent from public.subscription_entitlements e where e.user_id = v_user for update;

  -- Out-of-order delivery: never let an older event overwrite a newer state.
  if v_ent.last_event_at is not null and v_event_at < v_ent.last_event_at then
    update private.billing_events set outcome = 'stale' where event_id = v_id;
    return jsonb_build_object('outcome', 'stale', 'replayed', false);
  end if;

  -- Events about a product the user is no longer on (after a crossgrade, say) change nothing.
  if v_type in ('CANCELLATION','BILLING_ISSUE','EXPIRATION','REFUND','PRODUCT_CHANGE','UNCANCELLATION','SUBSCRIPTION_EXTENDED')
     and v_ent.store_product_id is distinct from v_product.product_id then
    -- 0044: an event for a product this user has never had applied can be a refund or
    -- cancellation that RevenueCat delivered BEFORE its purchase. It is kept as
    -- 'deferred' (not final) and resolved when that purchase lands, below.
    if v_type in ('CANCELLATION','EXPIRATION','REFUND') and not exists (
      select 1 from private.billing_events be
       where be.user_id = v_user and be.product_id = v_product.product_id and be.outcome in ('applied','applied_deferred')) then
      update private.billing_events set outcome = 'deferred' where event_id = v_id;
      return jsonb_build_object('outcome', 'deferred', 'replayed', false);
    end if;
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
    -- 0044: a refund / cancellation / expiration of this product that arrived before
    -- this grant, and is newer than it, now takes effect (newest last).
    for v_def in
      select * from private.billing_events be
       where be.user_id = v_user and be.product_id = v_product.product_id and be.outcome = 'deferred' and be.event_at > v_event_at
       order by be.event_at, be.event_id
    loop
      if v_def.event_type = 'CANCELLATION' and coalesce(v_def.cancel_reason, '') <> 'CUSTOMER_SUPPORT' then
        update public.subscription_entitlements set cancel_at_period_end = true,
          current_period_end = coalesce(v_def.expiration_at, current_period_end), last_event_at = v_def.event_at, updated_at = now()
        where user_id = v_user;
      else
        update public.subscription_entitlements set status = 'expired', cancel_at_period_end = false, pending_plan = null,
          current_period_end = case when v_def.event_type = 'EXPIRATION' then coalesce(v_def.expiration_at, current_period_end)
                                    else least(coalesce(current_period_end, v_now), v_now) end,
          last_event_at = v_def.event_at, updated_at = now()
        where user_id = v_user;
        perform private.apm_billing_lapse_founding(v_user, case when v_def.event_type = 'EXPIRATION' then 'expired' else 'refunded' end);
      end if;
      update private.billing_events set outcome = 'applied_deferred' where event_id = v_def.event_id;
      perform private.apm_billing_audit(v_user, 'billing.' || case when v_def.event_type = 'CANCELLATION' and coalesce(v_def.cancel_reason, '') <> 'CUSTOMER_SUPPORT' then 'cancellation'
                                                               when v_def.event_type = 'EXPIRATION' then 'expiration' else 'refund' end,
        jsonb_build_object('eventId', v_def.event_id, 'productId', v_product.product_id, 'deferred', true, 'appliedWith', v_id));
    end loop;

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

-- The export registry (0043) covers the new user-owned table.
insert into private.data_rights_tables (table_schema, table_name, user_column) values ('private', 'billing_founding_lapsed', 'user_id')
on conflict do nothing;
