// Worker fixes from the 7 Oct 2026 review (api P1-3, P1-4, P1-6, P2-8, P2-9, P2-11, P2-12, P2-14):
// UTF-8 Gmail bodies, untrusted model signals, the commitments conflict target, the
// one-transaction calendar window, Expo tickets and dead tokens, claim-first radar
// pushes, push registration through the service role, and the dev auth bypass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let email; let calendar; let push; let devApp; let prodApp;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-connectors-'));
  const entries = { email: join(srcDir, 'connectors/email.ts'), calendar: join(srcDir, 'connectors/calendar.ts'), push: join(srcDir, 'push.ts'), dev: join(srcDir, 'index.ts') };
  await build({ entryPoints: entries, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  await build({ entryPoints: { prod: join(srcDir, 'index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent', define: { __APM_RUNTIME_ENVIRONMENT__: "'production'" } });
  const load = (name) => import(pathToFileURL(join(outDir, `${name}.js`)).href);
  [email, calendar, push] = await Promise.all([load('email'), load('calendar'), load('push')]);
  devApp = (await load('dev')).default;
  prodApp = (await load('prod')).default;
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url).replace(env.SUPABASE_URL, ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, apikey: new Headers(init.headers).get('apikey') };
    calls.push(call);
    const { status = 200, json } = await handler(call);
    return new Response(status === 204 ? null : JSON.stringify(json ?? null), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('Gmail bodies decode as UTF-8; model signals are untrusted (bad dates nulled, confidence clamped, wrong shapes skipped)', () => {
  const encoded = Buffer.from('Café “quoted” — Zoë', 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  assert.equal(email.decodeBase64Url(encoded), 'Café “quoted” — Zoë');
  assert.deepEqual(email.sanitizeSignals({}), [], 'valid JSON in the wrong shape never throws');
  assert.deepEqual(email.sanitizeSignals(null), []);
  const out = email.sanitizeSignals({ signals: [
    { type: 'deadline', summary: 'Send the deck', owner: 'user', dueAt: 'next Tuesday', confidence: 1.7 },
    { type: 'deadline', summary: 'File taxes', owner: 'user', dueAt: '2026-10-20T17:00:00Z', confidence: 0.9 },
    { type: 'nonsense', summary: 'x', owner: 'user', dueAt: null, confidence: 0.9 },
    { type: 'request', summary: '   ', owner: 'user', dueAt: null, confidence: 0.9 },
    { type: 'request', summary: 'Call back', owner: 'robot', dueAt: null, confidence: 0.9 },
    { type: 'request', summary: 'Call back', owner: 'other', dueAt: null, confidence: 'high' },
  ] });
  assert.deepEqual(out, [
    { type: 'deadline', summary: 'Send the deck', owner: 'user', dueAt: null, confidence: 1 },
    { type: 'deadline', summary: 'File taxes', owner: 'user', dueAt: '2026-10-20T17:00:00.000Z', confidence: 0.9 },
  ]);
});

test('the commitment upsert targets the full source identity and never blind-inserts', async () => {
  const source = await readFile(join(srcDir, 'connectors/email.ts'), 'utf8');
  assert.match(source, /commitments\?on_conflict=user_id,source_type,source_ref,title/);
  assert.match(source, /resolution=ignore-duplicates/, 'a re-sync never overwrites a commitment the user corrected');
  assert.doesNotMatch(source, /\.catch\(async \(\) => \{\s*return supabaseRest/, 'no fallback insert');
});

test('the calendar window is replaced in one RPC; duplicate ids are refused before anything is sent', async () => {
  const mock = mockFetch((call) => {
    assert.equal(call.url, '/rest/v1/rpc/apm_replace_calendar_window');
    return { json: call.body.p_events.length };
  });
  try {
    const event = (id) => ({ provider: 'device', externalEventId: id, title: 'Standup', startsAt: '2026-10-08T09:00:00Z', endsAt: '2026-10-08T09:15:00Z', allDay: false, availability: 'busy' });
    const count = await calendar.syncDeviceCalendar({ env, accessToken: 'jwt', userId: USER, events: [event('a:1'), event('a:2')], from: '2026-10-01T00:00:00Z', to: '2026-12-31T00:00:00Z' });
    assert.deepEqual(count, { count: 2 });
    assert.equal(mock.calls.length, 1, 'no separate DELETE then INSERT');
    await assert.rejects(calendar.syncDeviceCalendar({ env, accessToken: 'jwt', userId: USER, events: [event('a'), event('a')], from: '2026-10-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }), /calendar_duplicate_event/);
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
  const mobile = await readFile(fileURLToPath(new URL('../../../apps/mobile/src/integrations/deviceCalendar.ts', import.meta.url)), 'utf8');
  assert.match(mobile, /externalEventId: `\$\{event\.id\}:\$\{new Date\(event\.startDate\)\.toISOString\(\)\}`/, 'each recurring occurrence has its own id');
});

test('Expo tickets decide delivery; DeviceNotRegistered tokens are deactivated', async () => {
  const mock = mockFetch((call) => {
    if (call.url === 'https://exp.host/--/api/v2/push/send') {
      return { json: { data: call.body.map((m) => (m.to === 'ExponentPushToken[dead]' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : m.to === 'ExponentPushToken[ok]' ? { status: 'ok', id: 't1' } : { status: 'error', details: { error: 'MessageRateExceeded' } })) } };
    }
    if (call.url === '/rest/v1/rpc/apm_service_deactivate_push_tokens') { assert.equal(call.apikey, env.SUPABASE_SECRET_KEY); return { json: 1 }; }
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    const dead = await push.sendExpoPush(env, [{ to: 'ExponentPushToken[dead]' }]);
    assert.deepEqual(dead, { delivered: false, error: 'expo_DeviceNotRegistered', deadTokens: ['ExponentPushToken[dead]'] });
    assert.deepEqual(mock.calls.find((c) => c.url.endsWith('apm_service_deactivate_push_tokens')).body, { p_tokens: ['ExponentPushToken[dead]'] });
    assert.equal((await push.sendExpoPush(env, [{ to: 'ExponentPushToken[dead]' }, { to: 'ExponentPushToken[ok]' }])).delivered, true);
    assert.equal((await push.sendExpoPush(env, [{ to: 'ExponentPushToken[busy]' }])).delivered, false, 'HTTP 200 with only error tickets is not sent');
  } finally { mock.restore(); }
});

test('radar pushes are claimed first: of two concurrent evaluations only one sends', async () => {
  const claimed = new Set();
  const mock = mockFetch((call) => {
    if (call.url.startsWith('/rest/v1/notification_preferences')) return { json: [{ enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal', minimum_severity: 'low' }] };
    if (call.url.startsWith('/rest/v1/push_subscriptions')) return { json: [{ expo_push_token: 'ExponentPushToken[ok]' }] };
    if (call.url.startsWith('/rest/v1/notifications?on_conflict=user_id,dedupe_key') && call.method === 'POST') {
      const key = call.body[0].dedupe_key;
      if (claimed.has(key)) return { status: 201, json: [] };
      claimed.add(key); return { status: 201, json: [{ id: `n-${key}` }] };
    }
    if (call.url.startsWith('/rest/v1/notifications?id=eq.') && call.method === 'PATCH') return { status: 204 };
    if (call.url === 'https://exp.host/--/api/v2/push/send') return { json: { data: [{ status: 'ok' }] } };
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  try {
    const items = [{ id: 'r1', status: 'open', severity: 'high', confidence: 0.9, headline: 'Due', reasonCodes: ['commitment.due_soon'] }];
    const [a, b] = await Promise.all([push.notifyRadarItems({ env, accessToken: 'jwt', userId: USER, radarItems: items }), push.notifyRadarItems({ env, accessToken: 'jwt', userId: USER, radarItems: items })]);
    assert.equal(a.sent + b.sent, 1);
    assert.equal(mock.calls.filter((c) => c.url.startsWith('https://exp.host/')).length, 1, 'one push');
    assert.equal(mock.calls.find((c) => c.method === 'PATCH').body.status, 'sent');
  } finally { mock.restore(); }
});

test('push registration goes through the service role (deactivating the token for any other account); unregister exists', async () => {
  const mock = mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_service_register_push_token') { assert.equal(call.apikey, env.SUPABASE_SECRET_KEY); return { status: 204 }; }
    if (call.url.startsWith('/rest/v1/push_subscriptions?user_id=eq.') && call.method === 'PATCH') return { status: 204 };
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  try {
    const devEnv = { ...env, AUTH_DEV_BYPASS_USER_ID: USER };
    const post = (path, body) => devApp.fetch(new Request(`https://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), devEnv);
    assert.equal((await post('/v1/push/register', { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' })).status, 200);
    assert.deepEqual(mock.calls[0].body, { p_user_id: USER, p_token: 'ExponentPushToken[abc]', p_device_id: null, p_platform: 'ios' });
    assert.equal((await post('/v1/push/unregister', { expoPushToken: 'ExponentPushToken[abc]' })).status, 200);
    assert.deepEqual(mock.calls[1].body.active, false);
  } finally { mock.restore(); }
  const session = await readFile(fileURLToPath(new URL('../../../apps/mobile/src/state/session.tsx', import.meta.url)), 'utf8');
  assert.match(session, /await disableApmPushForSignOut\(session\.access_token\);\s*\n\s*const \{ error: signOutError \} = await supabase\.auth\.signOut\(\)/, 'sign-out unregisters before the session ends');
});

test('the dev auth bypass works only in development; a deployed Worker ignores it and its health fails', async () => {
  const bypass = { ...env, AUTH_DEV_BYPASS_USER_ID: USER };
  const mock = mockFetch((call) => {
    if (call.url === '/auth/v1/user') return { status: 401, json: {} };
    return { json: [] };
  });
  try {
    const prodHealth = await prodApp.fetch(new Request('https://api.test/v1/health'), bypass);
    assert.equal(prodHealth.status, 503);
    assert.equal((await prodHealth.json()).error, 'dev_auth_bypass_configured');
    assert.equal((await prodApp.fetch(new Request('https://api.test/v1/trust/activity'), bypass)).status, 401, 'no token → no user, whatever the variable says');
    assert.equal((await prodApp.fetch(new Request('https://api.test/v1/health'), env)).status, 200);
    assert.equal((await devApp.fetch(new Request('https://api.test/v1/health'), bypass)).status, 200);
    assert.equal((await devApp.fetch(new Request('https://api.test/v1/trust/activity'), bypass)).status, 200, 'local development keeps the escape hatch');
  } finally { mock.restore(); }
});
