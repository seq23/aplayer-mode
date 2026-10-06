-- Household OS is waitlist-only under ADR-0002.
-- Keep existing rows readable under the established membership RLS, but remove all
-- authenticated customer mutation policies so the Supabase Data API cannot bypass
-- the Cloudflare waitlist-only boundary.

drop policy if exists households_owner_insert on public.households;
drop policy if exists households_owner_update on public.households;
drop policy if exists households_owner_delete on public.households;

drop policy if exists household_members_owner_insert on public.household_members;
drop policy if exists household_members_owner_update on public.household_members;
drop policy if exists household_members_owner_delete on public.household_members;

drop policy if exists household_items_member_insert on public.household_items;
drop policy if exists household_items_member_update on public.household_items;
drop policy if exists household_items_member_delete on public.household_items;
