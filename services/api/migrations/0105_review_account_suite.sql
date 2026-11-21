-- 0105: App Review can reach Executive Suite and Autopilot (21 Nov 2026). Additive only.
--
-- The review account (0070) had closed-beta access, which is Executive Roundtable only, so a
-- reviewer could not open the Suite or Autopilot screens the listing describes. The one
-- allowlisted review address may now hold Autopilot, with no purchase, until its allowlist
-- end date, and gets a few clearly labelled sample Life-areas items so Suite cards and Radar
-- have something real to work on without a Google or Microsoft account. It never grants
-- autonomy: every permission stays off until the reviewer switches it on.
alter table private.beta_allowlist add column review_plan text check (review_plan in ('autopilot'));
update private.beta_allowlist set review_plan = 'autopilot' where email = 'appreview@aplayermode.com';

create function public.apm_service_review_account_prepare(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_until timestamptz;
  v_plan text;
  v_sample uuid := md5(p_user_id::text || ':review-sample:shopping')::uuid;
begin
  select b.granted_until, b.review_plan into v_until, v_plan
    from auth.users u join private.beta_allowlist b on b.email = lower(btrim(u.email))
   where u.id = p_user_id and b.review_plan is not null and b.granted_until > now();
  if v_plan is null then raise exception 'review_account_only'; end if;

  -- A store or web subscription always governs: the grant never overwrites one.
  insert into public.subscription_entitlements (user_id, plan, status, provider, current_period_end, updated_at)
    values (p_user_id, v_plan, 'active', null, v_until, now())
    on conflict (user_id) do update set plan = excluded.plan, status = 'active', current_period_end = excluded.current_period_end, updated_at = now()
    where public.subscription_entitlements.provider is null;

  -- Sample items, re-timed on every review sign-in so they are always ahead today.
  insert into public.life_admin_items (id, user_id, kind, title, status, importance, starts_at, ends_at, details, provenance_kind, source_type)
    values (v_sample, p_user_id, 'shopping', 'Pick up groceries for the week (sample)', 'scheduled', 2,
            now() + interval '2 hours', now() + interval '2 hours 30 minutes', '{"flexibleSchedule": true, "sample": true}', 'stated', 'manual')
    on conflict (id) do update set status = 'scheduled', starts_at = excluded.starts_at, ends_at = excluded.ends_at, completed_at = null, updated_at = now();
  insert into public.life_admin_items (id, user_id, kind, title, status, importance, due_at, amount_minor, currency, recurrence, details, provenance_kind, source_type)
    values (md5(p_user_id::text || ':review-sample:bill')::uuid, p_user_id, 'bill', 'Car insurance renewal (sample)', 'open', 4,
            now() + interval '3 days', 64000, 'USD', '{"frequency": "yearly"}', '{"sample": true}', 'stated', 'manual')
    on conflict (id) do update set status = 'open', due_at = excluded.due_at, completed_at = null, updated_at = now();
  insert into public.life_admin_items (id, user_id, kind, title, status, importance, starts_at, ends_at, details, provenance_kind, source_type)
    values (md5(p_user_id::text || ':review-sample:appointment')::uuid, p_user_id, 'appointment', 'Dentist check-up (sample)', 'scheduled', 3,
            now() + interval '1 day 5 hours', now() + interval '1 day 5 hours 30 minutes', '{"sample": true}', 'stated', 'manual')
    on conflict (id) do update set status = 'scheduled', starts_at = excluded.starts_at, ends_at = excluded.ends_at, completed_at = null, updated_at = now();

  return jsonb_build_object('plan', v_plan, 'until', v_until);
end;
$$;
revoke all on function public.apm_service_review_account_prepare(uuid) from public, anon, authenticated;
grant execute on function public.apm_service_review_account_prepare(uuid) to service_role;
