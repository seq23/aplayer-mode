-- Make Household's waitlist-only state explicit to both Postgres and security tooling.
-- These policies intentionally deny every authenticated command. A later Household
-- launch must replace them through a separately approved migration.

create policy households_waitlist_disabled
  on public.households for all to authenticated
  using (false) with check (false);

create policy household_members_waitlist_disabled
  on public.household_members for all to authenticated
  using (false) with check (false);

create policy household_items_waitlist_disabled
  on public.household_items for all to authenticated
  using (false) with check (false);
