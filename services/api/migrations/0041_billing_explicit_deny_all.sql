-- Make the billing tables' server-only state explicit to Postgres and to security
-- tooling (Supabase advisor lint 0008, rls_enabled_no_policy). These policies deny
-- every anon/authenticated command; the tables are already unreachable (private
-- schema, all privileges revoked). Only the service-role SECURITY DEFINER functions
-- of 0040 read or write them.

create policy billing_products_server_only
  on private.billing_products for all to anon, authenticated
  using (false) with check (false);

create policy billing_events_server_only
  on private.billing_events for all to anon, authenticated
  using (false) with check (false);

create policy billing_founding_slots_server_only
  on private.billing_founding_slots for all to anon, authenticated
  using (false) with check (false);
