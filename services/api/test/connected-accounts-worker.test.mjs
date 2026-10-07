// Connected accounts in the Worker (0065): a paused account (a downgrade's extra) neither
// syncs nor acts, but Undo still reaches the account that acted; the database's refusals map
// to plain answers (409 connection_paused) instead of a 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let oauth; let engine; let crypto;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-accounts-'));
  await build({ entryPoints: { oauth: join(srcDir, 'connectors/oauth.ts'), engine: join(srcDir, 'actionEngine.ts'), crypto: join(srcDir, 'crypto.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  const load = (name) => import(pathToFileURL(join(outDir, `${name}.js`)).href);
  [oauth, engine, crypto] = await Promise.all([load('oauth'), load('engine'), load('crypto')]);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const PERSONAL = '22222222-2222-4222-8222-222222222222';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString('base64') };

async function withPausedAccount(run) {
  const sealed = await crypto.encryptConnectorCredential(env, { accessToken: 'ya29.personal', expiresAt: Date.now() + 3_600_000 });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); calls.push(`${init.method ?? 'GET'} ${href}`);
    if (href.includes('/rest/v1/integration_connections')) {
      assert.match(href, /select=[^&]*paused_at/, 'the token loader reads the pause');
      return new Response(JSON.stringify([{ id: PERSONAL, provider: 'google', kind: 'email', encrypted_credentials: sealed.ciphertext, credential_iv: sealed.iv, paused_at: '2026-10-07T00:00:00Z' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.startsWith('https://gmail.googleapis.com/')) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${href}`);
  };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

test('a paused account yields no token for sync or actions', async () => {
  await withPausedAccount(async (calls) => {
    await assert.rejects(oauth.getValidConnectorToken({ env, accessToken: 'jwt', userId: USER, connectionId: PERSONAL }), /connection_paused/);
    assert.ok(!calls.some((call) => call.includes('googleapis.com')), 'nothing reached the provider');
  });
});

test('undo still reaches the account that acted, even after it was paused', async () => {
  await withPausedAccount(async (calls) => {
    await engine.revertStandingConnectorAction({ undoMethod: 'delete_draft', connectionId: PERSONAL, externalRef: 'draft-123' }, { env, accessToken: 'jwt', userId: USER });
    assert.ok(calls.some((call) => call === 'DELETE https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-123'), calls.join('\n'));
  });
});

test('the database refusal for a paused account maps to 409 connection_paused', () => {
  assert.deepEqual(engine.actionErrorResponse(new Error('action_connection_paused')), { error: 'connection_paused', status: 409 });
  assert.deepEqual(engine.actionErrorResponse(new Error('connection_paused')), { error: 'connection_paused', status: 409 });
});
