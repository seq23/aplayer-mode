-- Optimize product_interests RLS auth lookups without changing access semantics.

drop policy if exists product_interests_select_own on public.product_interests;
drop policy if exists product_interests_insert_own on public.product_interests;
drop policy if exists product_interests_update_own on public.product_interests;
drop policy if exists product_interests_delete_own on public.product_interests;

create policy product_interests_select_own
  on public.product_interests for select to authenticated
  using ((select auth.uid()) = user_id);

create policy product_interests_insert_own
  on public.product_interests for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy product_interests_update_own
  on public.product_interests for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy product_interests_delete_own
  on public.product_interests for delete to authenticated
  using ((select auth.uid()) = user_id);
