-- A Player Mode three-tier product contract
-- Household stays waitlist-only; this table records authenticated interest without
-- activating household product capability.

create table public.product_interests (
  user_id uuid not null references auth.users(id) on delete cascade,
  interest text not null check (interest in ('household')),
  status text not null default 'interested' check (status in ('interested','withdrawn')),
  source text not null default 'mobile_settings',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, interest)
);

alter table public.product_interests enable row level security;

create policy product_interests_select_own
  on public.product_interests for select to authenticated
  using (auth.uid() = user_id);

create policy product_interests_insert_own
  on public.product_interests for insert to authenticated
  with check (auth.uid() = user_id);

create policy product_interests_update_own
  on public.product_interests for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy product_interests_delete_own
  on public.product_interests for delete to authenticated
  using (auth.uid() = user_id);
