-- 0097: the Founding 100 count also holds places for PAID pay-first checkouts not yet claimed.
--
-- 9 Oct 2026: "Join the Founding 100" sells before any account exists (docs/33 §10). Until the
-- buyer claims (or attaches) the checkout, its webhook is recorded as ignored_unknown_user and
-- holds no slot, so at 99 claimed several pay-first buyers could each be sold the founding price
-- and only one would ever get a place. A founding price must never be sold past 100, so a paid,
-- unexpired, unclaimed founding checkout now counts as taken in both the public count
-- (GET /v1/billing/founding, the join buttons) and the paywall's offering. Slots themselves are
-- unchanged: a pending checkout takes a real slot when it is claimed (the account then exists,
-- so it stops counting as pending), exactly as before.

-- Paid founding checkouts with no account and no link yet: distinct checkout ids whose newest
-- production founding purchase/renewal is unexpired at p_now.
create or replace function private.apm_billing_founding_pending(p_now timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct e.app_user_id)::integer
    from private.billing_events e
    join private.billing_products p on p.product_id = e.product_id and p.offer = 'founding'
   where e.outcome = 'ignored_unknown_user'
     and e.environment = 'PRODUCTION'
     and e.event_type in ('INITIAL_PURCHASE','RENEWAL','UNCANCELLATION','SUBSCRIPTION_EXTENDED')
     and e.expiration_at > p_now
     and e.app_user_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and not exists (select 1 from auth.users u where u.id = e.app_user_id::uuid)
     and not exists (select 1 from private.billing_checkout_links l where l.checkout_id = e.app_user_id::uuid);
$$;
revoke all on function private.apm_billing_founding_pending(timestamptz) from public, anon, authenticated;
grant execute on function private.apm_billing_founding_pending(timestamptz) to service_role;

-- Places taken = claimed slots + paid checkouts waiting to be claimed.
create or replace function private.apm_billing_founding_taken(p_now timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*)::integer from private.billing_founding_slots s where s.status = 'claimed')
       + private.apm_billing_founding_pending(p_now);
$$;
revoke all on function private.apm_billing_founding_taken(timestamptz) from public, anon, authenticated;
grant execute on function private.apm_billing_founding_taken(timestamptz) to service_role;

create or replace function private.apm_billing_founding_spots_left(p_now timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 100 - private.apm_billing_founding_taken(p_now));
$$;

-- The paywall: unchanged from 0044 except that the count includes pending paid checkouts.
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
     and private.apm_billing_founding_taken(p_now) < 100 then
    return jsonb_build_object('offering', 'founding', 'founding', false, 'reservedUntil', null);
  end if;
  return jsonb_build_object('offering', 'default', 'founding', false, 'reservedUntil', null);
end;
$$;
