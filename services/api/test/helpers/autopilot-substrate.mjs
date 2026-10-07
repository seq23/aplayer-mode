// Minimal Supabase-shaped substrate for the Autopilot migrations (0018, 0019, 0033):
// auth.uid(), anon/authenticated/service_role, Supabase's default public-schema
// grants, and the tables the Autopilot functions read, with own-row policies.
export const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;

  create schema private;
  revoke all on schema private from public;
  grant usage on schema private to authenticated;

  create table public.audit_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    event_type text not null,
    actor_type text not null check (actor_type in ('user','system','connector','ai')),
    actor_ref text, object_type text, object_id text, data_class text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create table public.subscription_entitlements (
    user_id uuid primary key references auth.users(id) on delete cascade,
    plan text not null default 'beta',
    status text not null default 'active',
    updated_at timestamptz not null default now()
  );
  create table public.permissions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    domain text not null, action_type text not null,
    autonomy_level integer not null default 0 check (autonomy_level between 0 and 5),
    constraints jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    granted_at timestamptz, updated_at timestamptz not null default now(),
    unique(user_id, domain, action_type)
  );
  create table public.actions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    domain text not null, action_type text not null,
    status text not null default 'proposed' check (status in ('proposed','prepared','approved','executing','executed','verified','closed','failed','cancelled')),
    payload jsonb not null default '{}'::jsonb,
    reason text not null,
    permission_id uuid references public.permissions(id) on delete set null,
    idempotency_key text not null,
    requires_approval boolean not null default true,
    approved_at timestamptz, executed_at timestamptz, verified_at timestamptz, failure_code text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique(user_id, idempotency_key)
  );
  create table public.action_attempts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    action_id uuid not null references public.actions(id) on delete cascade,
    attempt integer not null,
    status text not null check (status in ('started','succeeded','failed')),
    provider text, external_ref text, error_code text,
    started_at timestamptz not null default now(), completed_at timestamptz,
    unique(action_id, attempt)
  );
  create table public.integration_connections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null, kind text not null,
    status text not null default 'connected',
    scopes text[] not null default '{}'
  );
  create table public.calendar_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null default 'device',
    external_event_id text not null default gen_random_uuid()::text,
    title text not null default '',
    starts_at timestamptz not null, ends_at timestamptz not null,
    availability text not null default 'busy',
    connection_id uuid references public.integration_connections(id) on delete cascade,
    all_day boolean not null default false,
    organizer jsonb not null default '{}'::jsonb,
    attendees jsonb not null default '[]'::jsonb,
    deleted boolean not null default false
  );
  create table public.personal_os (
    user_id uuid primary key references auth.users(id) on delete cascade,
    active_mode text not null default 'standard',
    mode_started_at timestamptz, mode_ends_at timestamptz
  );
  create table public.commitments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null default 'x',
    owner text not null default 'user' check (owner in ('user','other')),
    status text not null default 'captured'
  );
  create table public.message_signals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    connection_id uuid references public.integration_connections(id) on delete cascade,
    signal_type text not null,
    summary text not null default ''
  );
  create table public.life_admin_items (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    kind text not null, title text not null,
    status text not null default 'open',
    importance smallint not null default 3,
    starts_at timestamptz, ends_at timestamptz,
    details jsonb not null default '{}'::jsonb,
    provenance_kind text not null default 'stated',
    source_type text not null default 'manual'
  );
  do $$
  declare t text;
  begin
    foreach t in array array['permissions','actions','action_attempts','integration_connections','calendar_events','personal_os','commitments','message_signals','life_admin_items'] loop
      execute format('alter table public.%I enable row level security', t);
      execute format('create policy %I on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_own', t);
    end loop;
  end $$;
  alter table public.audit_events enable row level security;
  alter table public.subscription_entitlements enable row level security;
  create policy audit_events_select_own on public.audit_events for select to authenticated using (auth.uid() = user_id);
  create policy audit_events_insert_own on public.audit_events for insert to authenticated with check (auth.uid() = user_id);
  create policy entitlements_select_own on public.subscription_entitlements for select to authenticated using (auth.uid() = user_id);
`;

/** Every provider write scope any Autopilot class needs (docs/22: write is a separate grant). */
export const ALL_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send',
  'Calendars.ReadWrite', 'Mail.ReadWrite', 'Mail.Send',
];

export const AUTOPILOT_MIGRATIONS = ['0018_autopilot_standing_rules.sql', '0019_autopilot_draft_header_hardening.sql', '0033_autopilot_action_classes.sql', '0034_autopilot_reschedule_shift_bound.sql'];
