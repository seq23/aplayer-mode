// Phone-calendar events can leave our server without deleting the account (issue #82).
// POST /v1/calendar/device/clear deletes AS THE USER (RLS) only provider='device' rows with no
// connection; with keepCalendarIds the chosen calendars stay. Proven twice: the Worker sends the
// right DELETE, and the real migration chain shows what that DELETE removes and what it keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { realChain, U } from './helpers/real-chain.mjs';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let entry;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-device-clear-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-0000000000d1';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function call(body, authorization = 'Bearer user-jwt') {
  const deletes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); const headers = new Headers(init.headers);
    if (href.endsWith('/auth/v1/user')) return headers.get('authorization') === 'Bearer user-jwt' ? json({ id: USER }) : json({}, 401);
    if (href.includes('/rpc/apm_my_consents')) return json({ ageConfirmedAt: '2026-10-08T00:00:00Z', healthData: null });
    if ((init.method ?? 'GET') === 'DELETE') { deletes.push({ href, auth: headers.get('authorization') }); return new Response(null, { status: 204 }); }
    return json([]);
  };
  try {
    const headers = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    const response = await entry.fetch(new Request('https://api.example/v1/calendar/device/clear', { method: 'POST', headers, body }), env, { waitUntil() {} });
    return { status: response.status, deletes };
  } finally { globalThis.fetch = original; }
}

test('signed in only: no token or a bad token deletes nothing', async () => {
  for (const auth of [null, 'Bearer someone-else']) {
    const result = await call('', auth);
    assert.equal(result.status, 401);
    assert.equal(result.deletes.length, 0);
  }
});

test('an empty body removes every stored phone event, as the user, and nothing else', async () => {
  const result = await call('');
  assert.equal(result.status, 200);
  assert.equal(result.deletes.length, 1);
  const url = new URL(result.deletes[0].href);
  assert.equal(url.pathname, '/rest/v1/calendar_events');
  assert.equal(url.searchParams.get('provider'), 'eq.device');
  assert.equal(url.searchParams.get('connection_id'), 'is.null');
  assert.equal(url.searchParams.get('or'), null);
  assert.equal(result.deletes[0].auth, 'Bearer user-jwt', 'runs as the user (RLS), never with the server key');
});

test('keepCalendarIds keeps the chosen calendars; a malformed body deletes nothing', async () => {
  const kept = await call(JSON.stringify({ keepCalendarIds: ['home', 'wo,rk"1'] }));
  assert.equal(kept.status, 200);
  assert.equal(new URL(kept.deletes[0].href).searchParams.get('or'), '(calendar_external_id.is.null,calendar_external_id.not.in.("home","wo,rk\\"1"))');
  for (const bad of ['{not json', JSON.stringify({ keepCalendarIds: 'home' }), JSON.stringify({ everything: true })]) {
    const result = await call(bad);
    assert.equal(result.status, 400, bad);
    assert.equal(result.deletes.length, 0, bad);
  }
});

test('on the real schema the same DELETE removes only this user\'s phone events from unchosen calendars', async () => {
  const h = await realChain();
  try {
    const A = U(301), B = U(302);
    await h.admin(`insert into auth.users (id) values ('${A}'), ('${B}')`);
    const google = (await h.as(A, `insert into public.integration_connections (user_id, provider, kind, external_account_id, account_label, status, scopes)
      values ($1, 'google', 'calendar', 'a@example.com', 'a@example.com', 'connected', '{}') returning id`, [A])).rows[0].id;
    const ev = (provider, id, calendar) => ({ provider, external_event_id: id, calendar_external_id: calendar, title: id, availability: 'busy',
      starts_at: new Date(Date.now() + 3_600_000).toISOString(), ends_at: new Date(Date.now() + 7_200_000).toISOString() });
    const put = (user, provider, connection, events) => h.as(user,
      "select public.apm_replace_calendar_window($1, $2::uuid, now() - interval '1 day', now() + interval '2 days', $3::jsonb)",
      [provider, connection, JSON.stringify(events)]);
    await put(A, 'device', null, [ev('device', 'home-1', 'home'), ev('device', 'work-1', 'work'), ev('device', 'none-1', null)]);
    await put(A, 'google', google, [ev('google', 'g-1', 'primary')]);
    await put(B, 'device', null, [ev('device', 'b-1', 'work')]);
    const ids = async () => (await h.admin('select external_event_id from public.calendar_events order by 1')).rows.map((r) => r.external_event_id);

    // keepCalendarIds: ['home'] — what the Worker sends after the user unticks "work".
    await h.as(A, `delete from public.calendar_events where provider = 'device' and connection_id is null
      and (calendar_external_id is null or calendar_external_id not in ('home'))`);
    assert.deepEqual(await ids(), ['b-1', 'g-1', 'home-1']);
    // Empty body — "Remove phone calendar events".
    await h.as(A, "delete from public.calendar_events where provider = 'device' and connection_id is null");
    assert.deepEqual(await ids(), ['b-1', 'g-1'], 'Google events and another person\'s phone events stay');
  } finally { await h.db.close(); }
});
