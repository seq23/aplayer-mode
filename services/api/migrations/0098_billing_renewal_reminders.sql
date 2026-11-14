-- 0098: a reminder email before an annual plan renews (risk R-SUB-03; California B&P 17602(b)
-- as amended 2024: notice 15 to 45 days before an auto-renewal of a year or longer).
--
-- RevenueCat Web Billing has an "upcoming yearly renewal" email, but it is a dashboard toggle that
-- is off unless enabled, and its state cannot be read through the API; Stripe sends nothing for
-- RevenueCat-managed subscriptions. So the API sends one plain-text reminder itself
-- (services/api/src/renewalReminders.ts), once per renewal, for active annual plans bought by card
-- (web) or through the App Store. Google Play emails its own annual-renewal reminders.
--
-- Additive only: one new table (one row per reminder sent, the dedupe key) and two service-role
-- functions. Nothing here changes an entitlement.

create table if not exists private.billing_renewal_reminders (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_end timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, period_end)
);
alter table private.billing_renewal_reminders enable row level security;
revoke all on table private.billing_renewal_reminders from public, anon, authenticated;
drop policy if exists billing_renewal_reminders_server_only on private.billing_renewal_reminders;
create policy billing_renewal_reminders_server_only
  on private.billing_renewal_reminders for all to anon, authenticated
  using (false) with check (false);
-- The person's own data: in the data-rights export (and erased with the account by the cascade).
insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns)
values ('private', 'billing_renewal_reminders', 'user_id', '{}')
on conflict do nothing;

-- Who is due at p_now: an active, auto-renewing annual web or App Store plan whose period ends
-- 15 to 45 days from now, with an email on the account and no reminder yet for that period end.
-- annualActive counts every active auto-renewing annual plan, so "none due" can say why.
create or replace function private.apm_billing_renewal_reminders_due(p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'annualActive', (select count(*) from public.subscription_entitlements a
                      where a.billing_period = 'annual' and a.status = 'active' and not a.cancel_at_period_end
                        and a.provider in ('web','app_store','google_play')),
    'due', coalesce((
      select jsonb_agg(jsonb_build_object('userId', e.user_id, 'email', u.email, 'plan', e.plan,
                                          'provider', e.provider, 'periodEnd', e.current_period_end)
                       order by e.current_period_end)
        from public.subscription_entitlements e
        join auth.users u on u.id = e.user_id
       where e.provider in ('web','app_store')
         and e.billing_period = 'annual'
         and e.status = 'active'
         and not e.cancel_at_period_end
         and e.current_period_end >= p_now + interval '15 days'
         and e.current_period_end <= p_now + interval '45 days'
         and coalesce(u.email, '') <> ''
         and not exists (select 1 from private.billing_renewal_reminders r
                          where r.user_id = e.user_id and r.period_end = e.current_period_end)
    ), '[]'::jsonb));
$$;

-- Records one sent reminder; true the first time, false when it was already recorded.
create or replace function private.apm_billing_renewal_reminder_sent(p_user_id uuid, p_period_end timestamptz)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_user_id is null or p_period_end is null then
    raise exception 'billing_invalid_request' using errcode = '22023';
  end if;
  insert into private.billing_renewal_reminders (user_id, period_end) values (p_user_id, p_period_end)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.apm_service_billing_renewal_reminders_due(p_now timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_billing_renewal_reminders_due(p_now); $$;
create or replace function public.apm_service_billing_renewal_reminder_sent(p_user_id uuid, p_period_end timestamptz)
returns boolean language sql volatile security invoker set search_path = ''
as $$ select private.apm_billing_renewal_reminder_sent(p_user_id, p_period_end); $$;

revoke all on function private.apm_billing_renewal_reminders_due(timestamptz) from public, anon, authenticated;
revoke all on function private.apm_billing_renewal_reminder_sent(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.apm_service_billing_renewal_reminders_due(timestamptz) from public, anon, authenticated;
revoke all on function public.apm_service_billing_renewal_reminder_sent(uuid, timestamptz) from public, anon, authenticated;
grant execute on function private.apm_billing_renewal_reminders_due(timestamptz) to service_role;
grant execute on function private.apm_billing_renewal_reminder_sent(uuid, timestamptz) to service_role;
grant execute on function public.apm_service_billing_renewal_reminders_due(timestamptz) to service_role;
grant execute on function public.apm_service_billing_renewal_reminder_sent(uuid, timestamptz) to service_role;
