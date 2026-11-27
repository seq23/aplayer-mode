-- 0108: a durable try counter for the App Review sign-in (security audit, 23 Nov 2026). Additive
-- only: one new private table and two service-only functions; no existing row or object changes.
--
-- POST /v1/auth/review-login accepts ONE fixed 6-digit code for the reviewer address. Its only
-- guard was a Workers rate-limit binding, which counts per Cloudflare location, so a guesser
-- spread over many locations multiplied it; and its "everyone" bucket let any stranger (or plain
-- sign-in traffic) use it up and lock the store reviewer out. The count now lives here, in the one
-- database every location shares (src/reviewLogin.ts takes a try BEFORE it compares the code):
--
--  * per device, per UTC day: p_device_cap wrong codes, then that device is locked until the day
--    ends. `device` is HMAC-SHA256 of the caller's network address (cf-connecting-ip, IPv6 cut to
--    its /64), keyed with a server secret: never a raw address.
--  * everyone together, per UTC day: p_global_cap wrong codes (the row whose device is 'all').
--    The device is counted FIRST and a locked device returns before the shared row is touched, so
--    one stranger can spend at most p_device_cap of the shared budget however long they hammer.
--  * the right code gives its try back (apm_service_review_login_release), so the reviewer's own
--    sign-ins never use up either budget.
--
-- Each statement is one atomic upsert with the cap in its WHERE, so parallel guesses cannot pass
-- the cap. Rows from earlier days are this function's own counters and are removed on each call.
-- No client role can read or write the table or run the functions (the Worker's server key only).

create table private.review_login_tries (
  day date not null,
  device text not null check (device = 'all' or device ~ '^[0-9a-f]{64}$'),
  tries integer not null check (tries >= 0),
  primary key (day, device)
);
alter table private.review_login_tries enable row level security;
revoke all on table private.review_login_tries from public, anon, authenticated;

create function public.apm_service_review_login_try(p_device text, p_device_cap integer, p_global_cap integer)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_tries integer;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{64}$'
     or p_device_cap is null or p_device_cap not between 1 and 1000
     or p_global_cap is null or p_global_cap not between 1 and 1000000 then
    raise exception 'review_login_try_invalid' using errcode = '22023';
  end if;

  delete from private.review_login_tries where day < v_day;

  insert into private.review_login_tries as t (day, device, tries) values (v_day, p_device, 1)
    on conflict (day, device) do update set tries = t.tries + 1 where t.tries < p_device_cap
    returning t.tries into v_tries;
  if v_tries is null then return 'device_locked'; end if;

  v_tries := null;
  insert into private.review_login_tries as t (day, device, tries) values (v_day, 'all', 1)
    on conflict (day, device) do update set tries = t.tries + 1 where t.tries < p_global_cap
    returning t.tries into v_tries;
  if v_tries is null then
    -- The shared budget is spent: this was not a counted guess, so the device keeps its try.
    update private.review_login_tries set tries = tries - 1 where day = v_day and device = p_device and tries > 0;
    return 'global_locked';
  end if;
  return 'ok';
end;
$$;
revoke all on function public.apm_service_review_login_try(text, integer, integer) from public, anon, authenticated;
grant execute on function public.apm_service_review_login_try(text, integer, integer) to service_role;

-- The code matched: give back the try taken for it (the device's and the shared one).
create function public.apm_service_review_login_release(p_device text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{64}$' then
    raise exception 'review_login_try_invalid' using errcode = '22023';
  end if;
  -- The device row first, then the shared row: the same order the try takes them in.
  update private.review_login_tries set tries = tries - 1 where day = v_day and device = p_device and tries > 0;
  update private.review_login_tries set tries = tries - 1 where day = v_day and device = 'all' and tries > 0;
end;
$$;
revoke all on function public.apm_service_review_login_release(text) from public, anon, authenticated;
grant execute on function public.apm_service_review_login_release(text) to service_role;
