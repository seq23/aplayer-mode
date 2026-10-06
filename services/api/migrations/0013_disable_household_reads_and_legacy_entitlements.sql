-- Household OS is waitlist-only under ADR-0002.
-- Close the remaining direct Supabase read path and normalize any legacy Household
-- entitlement to the highest currently offered individual tier.

drop policy if exists households_member_read on public.households;
drop policy if exists household_members_member_read on public.household_members;
drop policy if exists household_items_member_read on public.household_items;

revoke execute on function private.apm_is_household_member(uuid) from authenticated;

update public.subscription_entitlements
set plan = 'autopilot',
    updated_at = now()
where plan = 'household';
