// App Review demo sign-in (docs/33 §8, docs/35): off unless BOTH env values are set;
// answers ONLY for the one reviewer address (every other address looks exactly like "off");
// the fixed code works only for that address; a sign-in is audited. The try counter and its
// lockouts are proven on the real route and the real SQL in review-login-tries-db.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let mod;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-review-login-'));
  await build({ entryPoints: { reviewLogin: join(srcDir, 'reviewLogin.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  mod = await import(pathToFileURL(join(outDir, 'reviewLogin.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const REVIEWER = 'appreview@aplayermode.com';
const USER = '00000000-0000-4000-8000-0000000007a1';
const CALLER = { ip: '203.0.113.7' };
const TRY = '/rest/v1/rpc/apm_service_review_login_try';
const RELEASE = '/rest/v1/rpc/apm_service_review_login_release';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', APP_REVIEW_EMAIL: REVIEWER, APP_REVIEW_CODE: '424242' };

function harness({ prepare = () => new Response(JSON.stringify({ plan: 'autopilot' }), { status: 200 }) } = {}) {
  const calls = []; const audits = []; const prepared = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(env.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(path);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (path === '/auth/v1/admin/users') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY); assert.equal(body.email, REVIEWER); return json({ msg: 'exists' }, 422); }
    if (path === '/auth/v1/admin/generate_link') { assert.deepEqual(body, { type: 'magiclink', email: REVIEWER }); return json({ id: USER, hashed_token: 'hash-1' }); }
    if (path === '/auth/v1/verify') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_PUBLISHABLE_KEY); assert.deepEqual(body, { type: 'magiclink', token_hash: 'hash-1' }); return json({ access_token: 'at', refresh_token: 'rt', user: { id: USER } }); }
    if (path === '/rest/v1/rpc/apm_service_review_login_try') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY); assert.match(body.p_device, /^[0-9a-f]{64}$/); return json('ok'); }
    if (path === '/rest/v1/rpc/apm_service_review_login_release') { assert.match(body.p_device, /^[0-9a-f]{64}$/); return new Response(null, { status: 204 }); }
    if (path === '/rest/v1/rpc/apm_service_record_audit') { audits.push(body); return new Response(null, { status: 204 }); }
    if (path === '/rest/v1/rpc/apm_service_review_account_prepare') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY); prepared.push(body); return prepare(); }
    throw new Error(`unexpected ${path}`);
  };
  return { calls, audits, prepared, restore: () => { globalThis.fetch = original; } };
}

test('off unless both values are set (and the code is exactly 6 digits, what the app can type): 404 for everyone, no network', async () => {
  const h = harness();
  try {
    for (const partial of [{ APP_REVIEW_EMAIL: undefined }, { APP_REVIEW_CODE: undefined }, { APP_REVIEW_CODE: '12345' }, { APP_REVIEW_CODE: '12345678' }, { APP_REVIEW_CODE: 'letmein!' }, { SUPABASE_SECRET_KEY: undefined }]) {
      const result = await mod.reviewLogin({ ...env, ...partial }, { email: REVIEWER, code: '424242' }, CALLER);
      assert.equal(result.status, 404, JSON.stringify(partial));
    }
    assert.deepEqual(h.calls, []);
  } finally { h.restore(); }
});

test('any other address looks exactly like "off"; the fixed code never works for it', async () => {
  const h = harness();
  try {
    for (const email of ['someone@example.com', 'APPREVIEW@aplayermode.co', '']) {
      assert.deepEqual(await mod.reviewLogin(env, { email }, CALLER), { status: 404, body: { error: 'not_found' } });
      assert.deepEqual(await mod.reviewLogin(env, { email, code: '424242' }, CALLER), { status: 404, body: { error: 'not_found' } });
    }
    assert.deepEqual(h.calls, []);
  } finally { h.restore(); }
});

test('the reviewer address: no email is sent; a wrong code is refused; the right code returns a session and an audit row', async () => {
  const h = harness();
  try {
    assert.deepEqual(await mod.reviewLogin(env, { email: ` ${REVIEWER.toUpperCase()} ` }, CALLER), { status: 200, body: { review: true } });
    assert.equal((await mod.reviewLogin(env, { email: REVIEWER, code: '000000' }, CALLER)).status, 401);
    assert.equal((await mod.reviewLogin(env, { email: REVIEWER, code: 424242 }, CALLER)).status, 401, 'the code is a string, exactly');
    assert.deepEqual(h.calls, [TRY], 'a wrong code costs one try and no account work; a code that is not text costs nothing');
    const ok = await mod.reviewLogin(env, { email: REVIEWER, code: '424242' }, CALLER);
    assert.deepEqual(ok, { status: 200, body: { review: true, session: { access_token: 'at', refresh_token: 'rt' } } });
    assert.deepEqual(h.calls, [TRY, TRY, RELEASE, '/auth/v1/admin/users', '/auth/v1/admin/generate_link', '/auth/v1/verify', '/rest/v1/rpc/apm_service_record_audit', '/rest/v1/rpc/apm_service_review_account_prepare']);
    assert.deepEqual(h.prepared, [{ p_user_id: USER }], 'the review account is prepared for Suite and Autopilot with the server key');
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].p_event_type, 'auth.review_login');
    assert.equal(h.audits[0].p_actor_type, 'user');
    assert.equal(h.audits[0].p_user_id, USER);
  } finally { h.restore(); }
});

test('the route is wired and the app falls back to the normal email code when it is off', async () => {
  const { readFile } = await import('node:fs/promises');
  const index = await readFile(join(srcDir, 'index.ts'), 'utf8');
  assert.match(index, /app\.post\('\/v1\/auth\/review-login'[\s\S]{0,400}reviewLogin\(c\.env as ApiEnv, await c\.req\.json\(\)\.catch\(\(\) => null\), \{ ip \}\)/);
  const session = await readFile(fileURLToPath(new URL('../../../apps/mobile/src/state/session.tsx', import.meta.url)), 'utf8');
  assert.match(session, /if \(\(await reviewerSignIn\(\{ email: address \}\)\)\?\.review\) \{ emailMode\.current = 'review'; return; \}/);
  assert.match(session, /supabase\(\)\.auth\.setSession\(review\.session\)/);
});

test('a failed review-account preparation never blocks the reviewer sign-in; it is a named stop', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const h = harness({ prepare: () => new Response(JSON.stringify({ message: 'review_account_only' }), { status: 400 }) });
  try {
    const ok = await mod.reviewLogin(env, { email: REVIEWER, code: '424242' }, CALLER);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.session.access_token);
  } finally { h.restore(); }
  assert.ok(warnings.some((line) => line.includes('NAMED STOP [REVIEW_ACCOUNT_PREPARE_FAILED]')));
});
