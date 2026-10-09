-- 0095: "Get launch updates" sign-ups from aplayermode.com (owner, 8 Oct 2026). No account, no
-- session: the landing page posts an email plus an explicit consent tick to the Worker
-- (POST /v1/launch-updates), which calls public.apm_service_launch_signup with the server key.
--
--  * private.launch_update_signups: one row per lower-cased email. The consent wording and its
--    version are stored as the SERVER's copy (services/api/src/launchUpdates.ts), never text the
--    browser sent. No client role can read or write the table (RLS on, no policies, no grants).
--  * Nothing here sends email. A later sender must honour unsubscribed_at.
--  * The same answer for a new and a repeated address, so the endpoint never reveals who signed up.
--  * scripts/deploy-api-production.sh (REQUIRED_RPCS) refuses to ship the Worker before this exists.

create table if not exists private.launch_update_signups (
  email text primary key
    check (email = lower(email) and length(email) between 6 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  source text not null check (source in ('aplayermode.com')),
  consent_text text not null check (length(consent_text) between 20 and 500),
  consent_version text not null check (length(consent_version) between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);
alter table private.launch_update_signups enable row level security;
revoke all on table private.launch_update_signups from public, anon, authenticated;

create or replace function public.apm_service_launch_signup(p_email text, p_source text, p_consent_text text, p_consent_version text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if length(v_email) not between 6 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_source is distinct from 'aplayermode.com'
     or length(coalesce(p_consent_text, '')) not between 20 and 500
     or length(coalesce(p_consent_version, '')) not between 1 and 20 then
    raise exception 'launch_signup_invalid' using errcode = '22023';
  end if;
  insert into private.launch_update_signups (email, source, consent_text, consent_version)
  values (v_email, p_source, p_consent_text, p_consent_version)
  on conflict (email) do update
    set consent_text = excluded.consent_text, consent_version = excluded.consent_version,
        updated_at = now(), unsubscribed_at = null;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.apm_service_launch_signup(text, text, text, text) from public, anon, authenticated;
grant execute on function public.apm_service_launch_signup(text, text, text, text) to service_role;
