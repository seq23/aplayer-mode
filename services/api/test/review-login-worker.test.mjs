// App Review demo sign-in (docs/33 §8, docs/35): off unless BOTH env values are set;
// answers ONLY for the one reviewer address (every other address looks exactly like "off");
// the fixed code works only for that address; a sign-in is audited.
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
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', APP_REVIEW_EMAIL: REVIEWER, APP_REVIEW_CODE: '424242' };

function harness() {
  const calls = []; const audits = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(env.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(path);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (path === '/auth/v1/admin/users') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY); assert.equal(body.email, REVIEWER); return json({ msg: 'exists' }, 422); }
    if (path === '/auth/v1/admin/generate_link') { assert.deepEqual(body, { type: 'magiclink', email: REVIEWER }); return json({ id: USER, hashed_token: 'hash-1' }); }
    if (path === '/auth/v1/verify') { assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_PUBLISHABLE_KEY); assert.deepEqual(body, { type: 'magiclink', token_hash: 'hash-1' }); return json({ access_token: 'at', refresh_token: 'rt', user: { id: USER } }); }
    if (path === '/rest/v1/rpc/apm_service_record_audit') { audits.push(body); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${path}`);
  };
  return { calls, audits, restore: () => { globalThis.fetch = original; } };
}

test('off unless both values are set (and the code is 6–12 digits): 404 for everyone, no network', async () => {
  const h = harness();
  try {
    for (const partial of [{ APP_REVIEW_EMAIL: undefined }, { APP_REVIEW_CODE: undefined }, { APP_REVIEW_CODE: '12345' }, { APP_REVIEW_CODE: 'letmein!' }, { SUPABASE_SECRET_KEY: undefined }]) {
      const result = await mod.reviewLogin({ ...env, ...partial }, { email: REVIEWER, code: '424242' });
      assert.equal(result.status, 404, JSON.stringify(partial));
    }
    assert.deepEqual(h.calls, []);
  } finally { h.restore(); }
});

test('any other address looks exactly like "off"; the fixed code never works for it', async () => {
  const h = harness();
  try {
    for (const email of ['someone@example.com', 'APPREVIEW@aplayermode.co', '']) {
      assert.deepEqual(await mod.reviewLogin(env, { email }), { status: 404, body: { error: 'not_found' } });
      assert.deepEqual(await mod.reviewLogin(env, { email, code: '424242' }), { status: 404, body: { error: 'not_found' } });
    }
    assert.deepEqual(h.calls, []);
  } finally { h.restore(); }
});

test('the reviewer address: no email is sent; a wrong code is refused; the right code returns a session and an audit row', async () => {
  const h = harness();
  try {
    assert.deepEqual(await mod.reviewLogin(env, { email: ` ${REVIEWER.toUpperCase()} ` }), { status: 200, body: { review: true } });
    assert.equal((await mod.reviewLogin(env, { email: REVIEWER, code: '000000' })).status, 401);
    assert.equal((await mod.reviewLogin(env, { email: REVIEWER, code: 424242 })).status, 401, 'the code is a string, exactly');
    assert.deepEqual(h.calls, [], 'no account work before the code matches');
    const ok = await mod.reviewLogin(env, { email: REVIEWER, code: '424242' });
    assert.deepEqual(ok, { status: 200, body: { review: true, session: { access_token: 'at', refresh_token: 'rt' } } });
    assert.deepEqual(h.calls, ['/auth/v1/admin/users', '/auth/v1/admin/generate_link', '/auth/v1/verify', '/rest/v1/rpc/apm_service_record_audit']);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].p_event_type, 'auth.review_login');
    assert.equal(h.audits[0].p_actor_type, 'user');
    assert.equal(h.audits[0].p_user_id, USER);
  } finally { h.restore(); }
});

test('the route is wired and the app falls back to the normal email code when it is off', async () => {
  const { readFile } = await import('node:fs/promises');
  const index = await readFile(join(srcDir, 'index.ts'), 'utf8');
  assert.match(index, /app\.post\('\/v1\/auth\/review-login'[\s\S]{0,200}reviewLogin\(c\.env as ApiEnv/);
  const session = await readFile(fileURLToPath(new URL('../../../apps/mobile/src/state/session.tsx', import.meta.url)), 'utf8');
  assert.match(session, /if \(\(await reviewerSignIn\(\{ email: address \}\)\)\?\.review\) \{ emailMode\.current = 'review'; return; \}/);
  assert.match(session, /supabase\(\)\.auth\.setSession\(review\.session\)/);
});
