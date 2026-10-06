-- Phase B hardening: separate data-rights visibility from paid capability.
-- Owners may always read their retained Life OS data. Product use and mutations
-- remain gated by active Life OS / Autopilot entitlement.

drop policy if exists life_relationships_select_life_os on public.life_relationships;
create policy life_relationships_select_own
  on public.life_relationships for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists life_admin_items_select_life_os on public.life_admin_items;
create policy life_admin_items_select_own
  on public.life_admin_items for select to authenticated
  using ((select auth.uid()) = user_id);

drop function if exists public.apm_export_life_os_state();

create index if not exists life_admin_items_user_person_idx
  on public.life_admin_items(user_id, person_id)
  where person_id is not null;
