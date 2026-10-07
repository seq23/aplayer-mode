-- 0042: Founding 100 eligibility at purchase time (own hostile review of 0040).
--
-- 0040 decided eligibility ("never held a store subscription") when the OFFERING was
-- shown, but a purchase of the founding product by a user with no slot claimed any free
-- slot. A modified client can load RevenueCat's `founding` offering itself, so a former
-- subscriber could buy the founding product directly and take the lock. The claim now
-- applies the same first-time-subscriber rule; the store charge is still honoured
-- (access), only the lock is withheld and audited as billing.founding_without_slot.

-- Claims a Founding 100 slot for a verified founding purchase. Returns true when the
-- user holds a claimed slot afterwards. Caller holds the founding advisory lock.
create or replace function private.apm_billing_claim_founding(p_user_id uuid, p_now timestamptz)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot private.billing_founding_slots;
  v_free smallint;
begin
  select * into v_slot from private.billing_founding_slots s where s.user_id = p_user_id for update;
  if v_slot.slot_no is not null then
    if v_slot.status = 'lapsed' then
      return false; -- a lapse loses the lock for good
    end if;
    update private.billing_founding_slots
       set status = 'claimed', claimed_at = coalesce(claimed_at, p_now), reserved_until = null, updated_at = now()
     where slot_no = v_slot.slot_no;
    return true;
  end if;
  -- No slot of their own (the reservation was reused, or the founding offering was
  -- bought without the server offering it): only a first-time subscriber may claim,
  -- exactly as apm_billing_offering decides. A former subscriber never gets the lock.
  if exists (select 1 from public.subscription_entitlements e where e.user_id = p_user_id and e.provider is not null)
     or exists (select 1 from private.billing_events be where be.user_id = p_user_id and be.outcome = 'applied') then
    return false;
  end if;
  -- Claim a slot only if one is free right now.
  select s.slot_no into v_free from private.billing_founding_slots s
   where s.status = 'reserved' and s.reserved_until < p_now
   order by s.slot_no limit 1 for update;
  if v_free is not null then
    update private.billing_founding_slots
       set user_id = p_user_id, status = 'claimed', claimed_at = p_now, reserved_until = null, lapsed_at = null, updated_at = now()
     where slot_no = v_free;
    return true;
  end if;
  select min(n)::smallint into v_free from generate_series(1, 100) as n
   where not exists (select 1 from private.billing_founding_slots s where s.slot_no = n);
  if v_free is null then
    return false;
  end if;
  insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at)
  values (v_free, p_user_id, 'claimed', p_now);
  return true;
end;
$$;

revoke all on function private.apm_billing_claim_founding(uuid, timestamptz) from public, anon, authenticated;
