// "Get launch updates" on aplayermode.com (migration 0095):
//   * the table is closed to every client role; only the service function writes it;
//   * one row per lower-cased email, the SERVER's consent wording and version, re-subscribe clears
//     unsubscribed_at, the same answer for a new and a repeated address;
//   * the route needs no session, demands an explicit consent tick of the current version, ignores
//     the honeypot, is rate-limited per IP, and lets ONLY aplayermode.com call it from a browser
//     (every other route keeps answering the app's own origin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { realChain, rejects } from './helpers/real-chain.mjs';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let entry; let launch;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-launch-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), launch: join(srcDir, 'launchUpdates.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  launch = await import(pathToFileURL(join(outDir, 'launch.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('0095: closed table, service-only writer, idempotent per email, server wording stored', async () => {
  const { admin, as, asRole, service } = await realChain();
  const call = (role, email = 'A@Example.com') => {
    const sql = "select public.apm_service_launch_signup($1, 'aplayermode.com', 'Email me A Player Mode launch updates.', '2026-10-08') as r";
    return role === 'service' ? service(sql, [email]) : role === 'anon' ? asRole('anon', null, sql, [email]) : as('00000000-0000-4000-8000-000000000001', sql, [email]);
  };
  await rejects(call('anon'), /permission denied/);
  await rejects(call('authenticated'), /permission denied/);
  await rejects(asRole('anon', null, 'select * from private.launch_update_signups'), /permission denied/);
  await rejects(as('00000000-0000-4000-8000-000000000001', 'select * from private.launch_update_signups'), /permission denied/);
  assert.deepEqual((await call('service')).rows[0].r, { ok: true });
  await admin("update private.launch_update_signups set unsubscribed_at = now()");
  assert.deepEqual((await call('service', ' a@example.COM ')).rows[0].r, { ok: true }, 'a repeat answers the same');
  const rows = (await admin('select email, source, consent_version, unsubscribed_at from private.launch_update_signups')).rows;
  assert.deepEqual(rows, [{ email: 'a@example.com', source: 'aplayermode.com', consent_version: '2026-10-08', unsubscribed_at: null }]);
  for (const bad of ['nope', 'a@b', '', 'x y@example.com']) await rejects(call('service', bad), /launch_signup_invalid/);
  await rejects(service("select public.apm_service_launch_signup('b@example.com', 'elsewhere.com', 'Email me A Player Mode launch updates.', '1')"), /launch_signup_invalid/);
});

function fakeDb() {
  const writes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('apm_service_launch_signup')) { writes.push({ body: JSON.parse(init.body), apikey: new Headers(init.headers).get('apikey') }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); }
    return original(url, init);
  };
  return { writes, restore: () => { globalThis.fetch = original; } };
}
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', ALLOWED_ORIGIN: 'https://app.aplayermode.com' };
const post = (body, origin = 'https://aplayermode.com', e = env) => entry.fetch(new Request('https://api.example/v1/launch-updates', {
  method: 'POST', headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body),
}), e, { waitUntil() {} });

test('route: consent of the current version, the server wording, honeypot, no session', async () => {
  const db = fakeDb();
  try {
    const ok = { email: ' Someone@Example.com ', consent: true, consentVersion: launch.LAUNCH_UPDATES_CONSENT.version };
    const r = await post(ok);
    assert.equal(r.status, 200);
    assert.deepEqual(db.writes.map((w) => [w.body, w.apikey]), [[{ p_email: 'someone@example.com', p_source: 'aplayermode.com', p_consent_text: launch.LAUNCH_UPDATES_CONSENT.text, p_consent_version: launch.LAUNCH_UPDATES_CONSENT.version }, 'sb_secret_test']]);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://aplayermode.com');
    for (const [body, status, error] of [
      [{ ...ok, consent: undefined }, 400, 'consent_required'], [{ ...ok, consent: 'yes' }, 400, 'consent_required'],
      [{ ...ok, email: 'nope' }, 400, 'invalid_email'], [{ ...ok, consentVersion: '2000-01-01' }, 409, 'consent_outdated'],
    ]) {
      const res = await post(body);
      assert.equal(res.status, status); assert.equal((await res.json()).error, error);
    }
    const bot = await post({ ...ok, website: 'http://spam' });
    assert.equal(bot.status, 200);
    assert.equal(db.writes.length, 1, 'refusals and the honeypot store nothing');
    // Rate-limited per IP.
    const limited = await post(ok, 'https://aplayermode.com', { ...env, RECONCILE_LIMITER: { limit: async ({ key }) => ({ success: key !== 'launch-updates:203.0.113.9' }) } });
    assert.equal(limited.status, 429);
    assert.equal(db.writes.length, 1);
  } finally { db.restore(); }
});

test('CORS: aplayermode.com only on this route; every other route keeps the app origin', async () => {
  const pre = await entry.fetch(new Request('https://api.example/v1/launch-updates', { method: 'OPTIONS', headers: { origin: 'https://aplayermode.com' } }), env, { waitUntil() {} });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://aplayermode.com');
  const evil = await entry.fetch(new Request('https://api.example/v1/launch-updates', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env, { waitUntil() {} });
  assert.equal(evil.headers.get('access-control-allow-origin'), 'https://app.aplayermode.com');
  const other = await entry.fetch(new Request('https://api.example/v1/health', { headers: { origin: 'https://aplayermode.com' } }), env, { waitUntil() {} });
  assert.equal(other.headers.get('access-control-allow-origin'), 'https://app.aplayermode.com');
});
