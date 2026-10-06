-- Keep the SECURITY DEFINER household membership helper out of the PostgREST-exposed public schema.
-- Authenticated users retain EXECUTE because RLS policies call the function, but it is no longer a public RPC surface.

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
grant usage on schema private to authenticated;

alter function public.apm_is_household_member(uuid) set schema private;

revoke all on function private.apm_is_household_member(uuid) from public;
revoke all on function private.apm_is_household_member(uuid) from anon;
grant execute on function private.apm_is_household_member(uuid) to authenticated;
