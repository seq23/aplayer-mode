-- 0096: pay first with an email that ALREADY has an account (owner-approved fix, 9 Oct 2026;
-- docs/33 §10). Before this, POST /v1/billing/precheckout/claim refused such a buyer with
-- email_has_account and a manual support step. Now the paid checkout attaches to THAT account,
-- but only after the buyer proves the inbox with the usual 6-digit code:
--
--  1. private.billing_checkout_links: checkout id (the RevenueCat app user id the buyer paid
--     under) -> the existing account's user id. One row per checkout id, written once, never
--     moved to another account. No client role can read or write it.
--  2. private.apm_billing_link_checkout writes a link ONLY for a user whose auth email equals
--     the email given (the Worker passes the email of the SIGNED-IN session, i.e. one proven
--     with the code, and has already checked it against RevenueCat's $email), never for a
--     checkout id that is itself an account, and never re-points an existing link.
--  3. apm_billing_apply_event resolves app_user_id through the link first (body otherwise
--     0092's), so the webhook's later RENEWAL / CANCELLATION / EXPIRATION for that checkout,
--     reconcile and the founding slot all land on the existing account through the ONE writer.
--  4. private.apm_billing_checkout_ids lists a user's linked checkouts for reconcile and the
--     customer portal.
--
-- Why a server-side link and not a RevenueCat transfer/alias: the project's restore behaviour is
-- "Keep with original App User ID" (transfers disabled, docs/33 §5) and the server ignores
-- TRANSFER events by design; the Worker's RevenueCat key is read-only. A link keeps RevenueCat
-- untouched and keeps the database the single owner of who gets what.
-- scripts/deploy-api-production.sh (REQUIRED_RPCS) refuses to ship the Worker before this exists.

create table if not exists private.billing_checkout_links (
  checkout_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  linked_at timestamptz not null default now(),
  check (checkout_id <> user_id)
);
create index if not exists billing_checkout_links_user_idx on private.billing_checkout_links (user_id);
alter table private.billing_checkout_links enable row level security;
revoke all on table private.billing_checkout_links from public, anon, authenticated;
create policy billing_checkout_links_server_only
  on private.billing_checkout_links for all to anon, authenticated
  using (false) with check (false);
-- The person's own data: in the data-rights export (and erased with the account by the cascade).
insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns)
values ('private', 'billing_checkout_links', 'user_id', '{}')
on conflict do nothing;

create or replace function private.apm_billing_link_checkout(p_checkout_id uuid, p_user_id uuid, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_checkout_id is null or p_user_id is null or p_checkout_id = p_user_id then
    raise exception 'billing_invalid_request' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and u.email is not null
                  and lower(u.email) = lower(btrim(coalesce(p_email, '')))) then
    return jsonb_build_object('linked', false, 'reason', 'email_mismatch');
  end if;
  if exists (select 1 from auth.users u where u.id = p_checkout_id) then
    return jsonb_build_object('linked', false, 'reason', 'already_claimed');
  end if;
  insert into private.billing_checkout_links (checkout_id, user_id) values (p_checkout_id, p_user_id)
  on conflict (checkout_id) do nothing;
  if found then
    perform private.apm_billing_audit(p_user_id, 'billing.checkout_linked', jsonb_build_object('checkoutId', p_checkout_id));
    return jsonb_build_object('linked', true, 'replayed', false);
  end if;
  select l.user_id into v_owner from private.billing_checkout_links l where l.checkout_id = p_checkout_id;
  if v_owner is distinct from p_user_id then
    return jsonb_build_object('linked', false, 'reason', 'already_claimed');
  end if;
  return jsonb_build_object('linked', true, 'replayed', true);
end;
$$;

create or replace function private.apm_billing_checkout_ids(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(l.checkout_id order by l.linked_at, l.checkout_id), '[]'::jsonb)
    from private.billing_checkout_links l where l.user_id = p_user_id;
$$;

-- Who owns a checkout id: the linked account, or null. The claim refuses a linked checkout.
create or replace function private.apm_billing_checkout_owner(p_checkout_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.user_id from private.billing_checkout_links l where l.checkout_id = p_checkout_id;
$$;

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
    -- 0096: a pay-first checkout attached to an EXISTING account follows its link (a link
    -- wins over an account id, so one payment can never feed two accounts).
    select l.user_id into v_user from private.billing_checkout_links l where l.checkout_id = v_app_user::uuid;
    if v_user is null then
      select u.id into v_user from auth.users u where u.id = v_app_user::uuid;
    end if;
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
       and bp.store = case v_store when 'APP_STORE' then 'app_store' when 'PLAY_STORE' then 'google_play'
                                    -- 0092: RevenueCat Web Billing (RC_BILLING) and its Stripe integration (STRIPE).
                                    when 'RC_BILLING' then 'web' when 'STRIPE' then 'web' end;
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


create or replace function public.apm_service_billing_link_checkout(p_checkout_id uuid, p_user_id uuid, p_email text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_billing_link_checkout(p_checkout_id, p_user_id, p_email); $$;
create or replace function public.apm_service_billing_checkout_ids(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_billing_checkout_ids(p_user_id); $$;
create or replace function public.apm_service_billing_checkout_owner(p_checkout_id uuid)
returns uuid language sql stable security invoker set search_path = ''
as $$ select private.apm_billing_checkout_owner(p_checkout_id); $$;

revoke all on function private.apm_billing_link_checkout(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.apm_billing_checkout_ids(uuid) from public, anon, authenticated;
revoke all on function private.apm_billing_checkout_owner(uuid) from public, anon, authenticated;
revoke all on function private.apm_billing_apply_event(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.apm_service_billing_link_checkout(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.apm_service_billing_checkout_ids(uuid) from public, anon, authenticated;
revoke all on function public.apm_service_billing_checkout_owner(uuid) from public, anon, authenticated;
grant execute on function private.apm_billing_link_checkout(uuid, uuid, text) to service_role;
grant execute on function private.apm_billing_checkout_ids(uuid) to service_role;
grant execute on function private.apm_billing_checkout_owner(uuid) to service_role;
grant execute on function private.apm_billing_apply_event(jsonb, boolean) to service_role;
grant execute on function public.apm_service_billing_link_checkout(uuid, uuid, text) to service_role;
grant execute on function public.apm_service_billing_checkout_ids(uuid) to service_role;
grant execute on function public.apm_service_billing_checkout_owner(uuid) to service_role;
