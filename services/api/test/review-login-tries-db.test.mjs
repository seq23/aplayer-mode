// The App Review sign-in's try counter (migration 0108), end to end: the REAL route in the bundled
// Worker entry, calling the REAL SQL on the real migration chain (PGlite stands behind the fake
// Supabase REST door). Security audit 23 Nov 2026: the fixed 6-digit code was guarded only by a
// Workers rate-limit binding, which counts per Cloudflare location (a spread-out guesser
// multiplied it), and by an "everyone" bucket any stranger could use up to lock the reviewer out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { migrationsDir, realChain, rejects } from './helpers/real-chain.mjs';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const REVIEWER = 'appreview@aplayermode.com';
const USER = '00000000-0000-4000-8000-0000000007a1';
const CODE = '424242';
const RIGHT_SESSION = { review: true, session: { access_token: 'at', refresh_token: 'rt' } };
// "Every location is a fresh one": the binding never refuses, as for a guesser spread over many
// Cloudflare locations. Only the database count can stop them.
const everyLocationFresh = { limit: async () => ({ success: true }) };
const baseEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', APP_REVIEW_EMAIL: REVIEWER, APP_REVIEW_CODE: CODE, RECONCILE_LIMITER: everyLocationFresh };

let outDir; let entry; let mod; let limits; let h;
/** How the try counter answers: 'real' runs the SQL; anything else is an outage of that shape. */
let counter = 'real'; let release = 'real';
let calls = [];
const originalFetch = globalThis.fetch;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-review-tries-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), reviewLogin: join(srcDir, 'reviewLogin.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  mod = await import(pathToFileURL(join(outDir, 'reviewLogin.js')).href);
  limits = mod.REVIEW_LOGIN_LIMITS;
  h = await realChain();
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(baseEnv.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    calls.push(path);
    if (path === '/rest/v1/rpc/apm_service_review_login_try') {
      assert.equal(new Headers(init.headers).get('apikey'), baseEnv.SUPABASE_SECRET_KEY, 'the counter is reached with the server key only');
      if (counter === 'network') throw new TypeError('fetch failed');
      if (counter === 'http500') return json({ message: 'upstream' }, 500);
      if (counter === 'missing') return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      if (counter === 'unknown-answer') return json('maybe');
      if (counter === 'empty') return new Response('', { status: 200 });
      return json((await h.service('select public.apm_service_review_login_try($1, $2, $3) as r', [body.p_device, body.p_device_cap, body.p_global_cap])).rows[0].r);
    }
    if (path === '/rest/v1/rpc/apm_service_review_login_release') {
      if (release === 'http500') return json({ message: 'upstream' }, 500);
      await h.service('select public.apm_service_review_login_release($1)', [body.p_device]);
      return new Response(null, { status: 204 });
    }
    if (path === '/auth/v1/admin/users') return json({ msg: 'exists' }, 422);
    if (path === '/auth/v1/admin/generate_link') return json({ id: USER, hashed_token: 'hash-1' });
    if (path === '/auth/v1/verify') return json({ access_token: 'at', refresh_token: 'rt', user: { id: USER } });
    if (path === '/rest/v1/rpc/apm_service_record_audit') return new Response(null, { status: 204 });
    if (path === '/rest/v1/rpc/apm_service_review_account_prepare') return json({ plan: 'autopilot' });
    throw new Error(`unexpected ${path}`);
  };
});
test.after(async () => { globalThis.fetch = originalFetch; if (outDir) await rm(outDir, { recursive: true, force: true }); });
test.beforeEach(async () => { counter = 'real'; release = 'real'; calls = []; await h.admin('delete from private.review_login_tries'); });

/** One request to the real route. `ip` is what Cloudflare saw; `headers` are whatever the caller chose to send. */
async function post({ ip, code, email = REVIEWER, env = baseEnv, headers = {} }) {
  const res = await entry.fetch(new Request('https://api.example.com/v1/auth/review-login', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers },
    body: JSON.stringify(code === undefined ? { email } : { email, code }),
  }), env);
  return { status: res.status, body: await res.json() };
}
const wrong = (n) => String(100000 + n);
const rows = async () => (await h.admin('select device, tries from private.review_login_tries order by device')).rows;
const shared = async () => (await rows()).find((r) => r.device === 'all')?.tries ?? 0;

test('a guesser spread over many Cloudflare locations meets ONE count: 10 wrong codes lock the device, then even the right code is refused', async () => {
  assert.equal(limits.devicePerDay, 10);
  for (let i = 0; i < limits.devicePerDay; i += 1) assert.deepEqual(await post({ ip: '203.0.113.7', code: wrong(i) }), { status: 401, body: { error: 'code_mismatch' } }, `guess ${i + 1}`);
  const eleventh = await post({ ip: '203.0.113.7', code: wrong(11) });
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.body.error, 'too_many_tries');
  const withTheCode = await post({ ip: '203.0.113.7', code: CODE });
  assert.equal(withTheCode.status, 429, 'a locked device stays locked whatever it sends');
  assert.equal(withTheCode.body.session, undefined);
  assert.ok(!calls.some((p) => p.startsWith('/auth/')), 'no account work for a locked device');
});

test('a stranger who keeps hammering spends only their own 10 of the shared budget; another device with the right code signs in', async () => {
  for (let i = 0; i < limits.devicePerDay + 100; i += 1) {
    const res = await post({ ip: '198.51.100.9', code: wrong(i) });
    assert.equal(res.status, i < limits.devicePerDay ? 401 : 429, `request ${i + 1}`);
  }
  assert.equal(await shared(), limits.devicePerDay, 'a locked device takes nothing more from the shared budget');
  assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE }), { status: 200, body: RIGHT_SESSION });
  assert.equal(await shared(), limits.devicePerDay, 'the right code gave its try back');
});

test('no shared burst bucket: other callers using up their own minute never 429 the reviewer (the old "review-login:all" hole)', async () => {
  // A binding that counts like the real one: 6 per key, per minute.
  const hits = new Map();
  const counting = { limit: async ({ key }) => { hits.set(key, (hits.get(key) ?? 0) + 1); return { success: hits.get(key) <= 6 }; } };
  const env = { ...baseEnv, RECONCILE_LIMITER: counting };
  // Ordinary sign-ins (every email sign-in asks this route first) and a stranger's guesses, from other addresses.
  for (let i = 0; i < 8; i += 1) assert.equal((await post({ ip: `192.0.2.${i + 1}`, email: `person${i}@example.com`, env })).status, 404);
  for (let i = 0; i < 12; i += 1) assert.equal((await post({ ip: '198.51.100.9', code: wrong(i), env })).status, i < 6 ? 401 : 429);
  assert.deepEqual(await post({ ip: '17.58.100.20', env }), { status: 200, body: { review: true } }, 'the app is told this is the reviewer, so it never sends an email code');
  assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE, env }), { status: 200, body: RIGHT_SESSION });
  assert.ok([...hits.keys()].every((key) => /^review-login:\d+\.\d+\.\d+\.\d+$/.test(key)), `every burst bucket belongs to one caller: ${[...hits.keys()].join(', ')}`);
});

test('everyone together: 500 wrong codes in a day pause the sign-in for the day, and the paused caller keeps their own tries', async () => {
  assert.equal(limits.globalPerDay, 500);
  assert.ok(limits.globalPerDay >= limits.devicePerDay * 50, 'one locked-out stranger is a small part of the shared budget');
  const devices = limits.globalPerDay / limits.devicePerDay;
  for (let d = 0; d < devices; d += 1) {
    for (let i = 0; i < limits.devicePerDay; i += 1) assert.equal((await post({ ip: `10.${Math.floor(d / 250)}.${d % 250}.1`, code: wrong(d * 10 + i) })).status, 401, `device ${d} guess ${i}`);
  }
  assert.equal(await shared(), limits.globalPerDay);
  const next = await post({ ip: '172.16.0.1', code: wrong(1) });
  assert.equal(next.status, 429);
  assert.equal(next.body.error, 'review_login_paused');
  const withTheCode = await post({ ip: '172.16.0.2', code: CODE });
  assert.equal(withTheCode.status, 429, 'the ceiling is a ceiling: no session past it, even with the code');
  assert.equal(withTheCode.body.session, undefined);
  assert.equal(await shared(), limits.globalPerDay, 'never past the cap');
  assert.equal((await rows()).filter((r) => r.device !== 'all' && r.tries === 0).length, 2, 'the two paused callers were not charged a try');
});

test('30 guesses at once from one device: exactly 10 are compared, the rest are refused', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => post({ ip: '203.0.113.50', code: wrong(i) })));
  assert.equal(results.filter((r) => r.status === 401).length, limits.devicePerDay);
  assert.equal(results.filter((r) => r.status === 429).length, 30 - limits.devicePerDay);
});

test('the reviewer with the right code: 30 sign-ins in a row from one device all work and leave nothing counted', async () => {
  for (let i = 0; i < 30; i += 1) assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE }), { status: 200, body: RIGHT_SESSION }, `sign-in ${i + 1}`);
  assert.deepEqual((await rows()).map((r) => r.tries), [0, 0]);
  // A typo or two on the way never locks the reviewer out either.
  assert.equal((await post({ ip: '17.58.100.20', code: '424243' })).status, 401);
  assert.equal((await post({ ip: '17.58.100.20', code: ' 424242 ' })).status, 200, 'spaces around the code are forgiven, as before');
});

test('a give-back that fails never blocks the reviewer: signed in, and it is a named stop', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  release = 'http500';
  assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE }), { status: 200, body: RIGHT_SESSION });
  assert.ok(warnings.some((line) => line.includes('NAMED STOP [REVIEW_LOGIN_RELEASE_FAILED]')));
});

test('the counter down, missing or answering nonsense: refused plainly (503), never a session, never a 500, and seen', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  for (const mode of ['network', 'http500', 'missing', 'unknown-answer', 'empty']) {
    counter = mode; calls = [];
    const res = await post({ ip: '17.58.100.20', code: CODE });
    assert.deepEqual(res, { status: 503, body: { error: 'review_login_unavailable' } }, mode);
    assert.ok(!calls.some((p) => p.startsWith('/auth/')), `${mode}: no session was made`);
    // People who are not the reviewer, and the "is this the reviewer?" question, never need the counter.
    assert.equal((await post({ ip: '192.0.2.1', email: 'someone@example.com' })).status, 404, mode);
    assert.deepEqual(await post({ ip: '17.58.100.20' }), { status: 200, body: { review: true } }, mode);
  }
  assert.equal(errors.filter((line) => line.includes('NAMED STOP [REVIEW_LOGIN_TRIES_UNAVAILABLE]')).length, 5);
});

test('only a code for the reviewer address reaches the counter: other addresses and the no-code question never do', async () => {
  assert.equal((await post({ ip: '192.0.2.1', email: 'someone@example.com' })).status, 404);
  assert.equal((await post({ ip: '192.0.2.1', email: 'someone@example.com', code: CODE })).status, 404);
  assert.equal((await post({ ip: '17.58.100.20' })).status, 200);
  assert.equal((await post({ ip: '17.58.100.20', code: 424242 })).status, 401, 'a code that is not text is never right');
  assert.deepEqual(calls, []);
  assert.deepEqual(await rows(), []);
});

test('the caller is who Cloudflare saw, never a header the caller sets: rotating x-forwarded-for buys no extra tries', async () => {
  for (let i = 0; i < limits.devicePerDay + 5; i += 1) {
    const res = await post({ ip: '198.51.100.9', code: wrong(i), headers: { 'x-forwarded-for': `10.9.${i}.1, 10.8.${i}.1`, 'x-real-ip': `10.7.${i}.1`, forwarded: `for=10.6.${i}.1` } });
    assert.equal(res.status, i < limits.devicePerDay ? 401 : 429, `request ${i + 1}`);
  }
  assert.equal((await rows()).length, 2, 'one device row and the shared row');
});

test('IPv6: every address in one /64 is one device; the next /64 is another', async () => {
  const sameHome = ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2:0:0:0:9', '2001:db8:1:2::a:b', '2001:db8:1:2:1::', '2001:db8:1:2:1:2:3:4', '2001:db8:1:2::ffff', '2001:db8:1:2:8000::1'];
  assert.equal(sameHome.length, limits.devicePerDay);
  for (const ip of sameHome) assert.equal((await post({ ip, code: wrong(1) })).status, 401, ip);
  assert.equal((await post({ ip: '2001:db8:1:2:dead:beef:0:1', code: wrong(2) })).status, 429, 'an 11th address in the same /64 is the same locked device');
  assert.equal((await post({ ip: '2001:db8:1:3::1', code: wrong(3) })).status, 401, 'the neighbouring /64 is its own device');
  assert.equal(mod.devicePrefix('2001:0DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(mod.devicePrefix('::1'), '0:0:0:0::/64');
  assert.equal(mod.devicePrefix(' 203.0.113.7 '), '203.0.113.7');
});

test('no cf-connecting-ip at all is one shared, counted device (never unlimited)', async () => {
  for (let i = 0; i < limits.devicePerDay; i += 1) assert.equal((await post({ code: wrong(i) })).status, 401);
  assert.equal((await post({ code: wrong(99), headers: { 'x-forwarded-for': '10.1.1.1' } })).status, 429);
});

test('a new UTC day starts every count again and yesterday\'s rows are removed', async () => {
  for (let i = 0; i < limits.devicePerDay; i += 1) await post({ ip: '203.0.113.7', code: wrong(i) });
  assert.equal((await post({ ip: '203.0.113.7', code: wrong(11) })).status, 429);
  await h.admin('update private.review_login_tries set day = day - 1');
  assert.equal((await post({ ip: '203.0.113.7', code: wrong(12) })).status, 401, 'yesterday\'s lockout is over');
  const days = (await h.admin("select count(*)::int as n from private.review_login_tries where day < (now() at time zone 'utc')::date")).rows[0].n;
  assert.equal(days, 0, 'old counters do not pile up');
  assert.deepEqual((await rows()).map((r) => r.tries), [1, 1]);
});

test('what is stored: a keyed hash and a count, never the address', async () => {
  await post({ ip: '203.0.113.7', code: wrong(1) });
  await post({ ip: '2001:db8:1:2::1', code: wrong(1) });
  const stored = await rows();
  assert.equal(stored.length, 3);
  for (const row of stored) assert.match(row.device, /^(all|[0-9a-f]{64})$/);
  const dump = JSON.stringify((await h.admin('select * from private.review_login_tries')).rows);
  assert.ok(!dump.includes('203.0.113') && !dump.includes('2001:db8'), 'no raw address in the table');
  // Keyed with the server secret (a plain hash of an IPv4 address can be reversed by trying all 2^32).
  const keyed = (text) => createHmac('sha256', baseEnv.SUPABASE_SECRET_KEY).update(text).digest('hex');
  const devices = stored.map((r) => r.device);
  assert.ok(devices.includes(keyed('review-login|203.0.113.7')));
  assert.ok(devices.includes(keyed('review-login|2001:db8:1:2::/64')));
  for (const plain of ['203.0.113.7', 'review-login|203.0.113.7']) assert.ok(!devices.includes(createHash('sha256').update(plain).digest('hex')));
});

test('APP_REVIEW_UNTIL: not set = as before; a future time = open; passed or unreadable = off (404) for everyone, with no counter call', async () => {
  for (const until of [undefined, '', '2999-01-01', '2999-01-01T00:00:00Z']) {
    const env = { ...baseEnv, APP_REVIEW_UNTIL: until };
    assert.deepEqual(await post({ ip: '17.58.100.20', env }), { status: 200, body: { review: true } }, String(until));
    assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE, env }), { status: 200, body: RIGHT_SESSION }, String(until));
  }
  calls = [];
  for (const until of ['2020-01-01', '2026-11-01T00:00:00Z', 'next friday', 'true', '0']) {
    const env = { ...baseEnv, APP_REVIEW_UNTIL: until };
    assert.deepEqual(await post({ ip: '17.58.100.20', env }), { status: 404, body: { error: 'not_found' } }, until);
    assert.deepEqual(await post({ ip: '17.58.100.20', code: CODE, env }), { status: 404, body: { error: 'not_found' } }, until);
  }
  assert.deepEqual(calls, [], 'a closed window makes no network call');
  // The boundary, on the handler with a fixed clock: open until the last millisecond before, closed at the moment itself.
  const at = Date.parse('2026-12-15T00:00:00Z');
  const env = { ...baseEnv, APP_REVIEW_UNTIL: '2026-12-15T00:00:00Z' };
  assert.equal((await mod.reviewLogin(env, { email: REVIEWER }, { ip: '17.58.100.20', nowMs: at - 1 })).status, 200);
  assert.equal((await mod.reviewLogin(env, { email: REVIEWER }, { ip: '17.58.100.20', nowMs: at })).status, 404);
  assert.equal((await mod.reviewLogin(env, { email: REVIEWER, code: CODE }, { ip: '17.58.100.20', nowMs: at + 1 })).status, 404);
  assert.equal(mod.reviewLoginEnabled(env, at - 1), true);
  assert.equal(mod.reviewLoginEnabled(env, at), false);
});

test('the database side: only the server key runs the counter; nobody else reads or writes it; bad arguments are refused', async () => {
  const device = 'a'.repeat(64);
  for (const role of ['anon', 'authenticated']) {
    await rejects(h.asRole(role, null, 'select public.apm_service_review_login_try($1, 10, 500)', [device]), /permission denied/);
    await rejects(h.asRole(role, null, 'select public.apm_service_review_login_release($1)', [device]), /permission denied/);
    await rejects(h.asRole(role, null, 'select * from private.review_login_tries'), /permission denied/);
    await rejects(h.asRole(role, null, "insert into private.review_login_tries (day, device, tries) values (current_date, 'all', 0)"), /permission denied/);
  }
  assert.equal((await h.admin("select relrowsecurity from pg_class where oid = 'private.review_login_tries'::regclass")).rows[0].relrowsecurity, true);
  for (const args of [['203.0.113.7', 10, 500], [null, 10, 500], [device, 0, 500], [device, 10, 0], [device, null, 500], [device, 10, null], [device, -1, 500], [device, 1001, 500]]) {
    await rejects(h.service('select public.apm_service_review_login_try($1, $2, $3)', args), /review_login_try_invalid/);
  }
  await rejects(h.service('select public.apm_service_review_login_release($1)', ['203.0.113.7']), /review_login_try_invalid/);
  assert.deepEqual(await rows(), [], 'a refused call counts nothing');
  // A give-back with nothing taken never goes below zero and never makes a row.
  await h.service('select public.apm_service_review_login_release($1)', [device]);
  assert.equal((await h.service('select public.apm_service_review_login_try($1, 10, 500) as r', [device])).rows[0].r, 'ok');
  await h.service('select public.apm_service_review_login_release($1)', [device]);
  await h.service('select public.apm_service_review_login_release($1)', [device]);
  assert.deepEqual((await rows()).map((r) => r.tries), [0, 0]);
});

test('migration 0108 is additive: it makes its own table and functions and touches no other table', async () => {
  const sql = (await readFile(join(migrationsDir, '0108_review_login_tries.sql'), 'utf8')).replace(/--.*$/gm, '');
  assert.ok(!/\b(drop|truncate|alter\s+(?:table|function)\s+(?!private\.review_login_tries))\b/i.test(sql), 'nothing dropped, nothing else altered');
  assert.ok(!/create\s+or\s+replace/i.test(sql), 'no existing function is replaced');
  const written = [...sql.matchAll(/\b(?:insert\s+into|delete\s+from|(?<!\bdo\s+)update)\s+([a-z_.]+)/gi)].map((m) => m[1]);
  assert.ok(written.length >= 5, `expected the counter statements, found ${written.length}`);
  assert.deepEqual([...new Set(written)], ['private.review_login_tries']);
});
