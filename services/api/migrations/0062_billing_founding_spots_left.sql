-- 0062: live Founding 100 scarcity for the paywall's introductory-offer banner.
--
-- The banner says "37 of 100 spots left" only with the server's number (never invented
-- urgency; the app hides the count when this is unavailable). Since 0044 only a paid,
-- active founding subscription holds a slot (viewing the paywall reserves nothing), so the
-- count is 100 minus the claimed slots. Service role only: the API adds it to
-- GET /v1/billing/offering.

create or replace function private.apm_billing_founding_spots_left(p_now timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 100 - (
    select count(*)::integer from private.billing_founding_slots s where s.status = 'claimed'
  ));
$$;

create or replace function public.apm_service_billing_founding_spots_left()
returns integer language sql stable security invoker set search_path = ''
as $$ select private.apm_billing_founding_spots_left(now()); $$;

revoke all on function private.apm_billing_founding_spots_left(timestamptz) from public, anon, authenticated;
grant execute on function private.apm_billing_founding_spots_left(timestamptz) to service_role;
revoke all on function public.apm_service_billing_founding_spots_left() from public, anon, authenticated;
grant execute on function public.apm_service_billing_founding_spots_left() to service_role;
