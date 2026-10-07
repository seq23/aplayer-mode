-- Phase E (docs/33 §8.0): the App Review reviewer account gets closed-beta access, so a
-- reviewer signed in with the fixed review code (docs/35) sees the full app without a store
-- purchase. Bounded like every beta grant; remove with the reviewer secrets after approval.
insert into private.beta_allowlist (email, granted_until, note)
values ('appreview@aplayermode.com', '2027-04-30T00:00:00Z', 'App Store / Play review account (0070)')
on conflict (email) do update set granted_until = excluded.granted_until, note = excluded.note;
