create table public.coaching_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.coaching_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index coaching_turns_session_idx on public.coaching_turns(user_id, session_id, created_at);
alter table public.coaching_turns enable row level security;
create policy coaching_turns_select_own on public.coaching_turns for select to authenticated using (auth.uid() = user_id);
create policy coaching_turns_insert_own on public.coaching_turns for insert to authenticated with check (auth.uid() = user_id);
create policy coaching_turns_delete_own on public.coaching_turns for delete to authenticated using (auth.uid() = user_id);

-- A single source message may contain multiple commitments, so source identity includes the title.
create unique index commitments_source_title_unique
  on public.commitments(user_id, source_type, source_ref, title)
  where source_ref is not null;

-- Users can inspect these tables; they may never modify platform model policy themselves.
revoke insert, update, delete on public.model_routes from authenticated;
