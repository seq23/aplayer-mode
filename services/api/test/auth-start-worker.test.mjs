// GET /v1/auth/:provider/start (retest 14 Nov 2026): the first URL a web sign-in opens, so iOS
// names aplayermode.com instead of the raw Supabase host. It 302s to the exact sign-in URL the
// app built, and only to an allowed one: never an open redirect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'apm-auth-start-'));
await build({ entryPoints: { entry: join(srcDir, 'entry.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent', define: { __APM_BUILD_SHA__: "'test-sha'", __APM_RUNTIME_ENVIRONMENT__: "'production'" } });
const worker = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
test.after(() => rm(outDir, { recursive: true, force: true }));

const SUPA = 'https://proj.supabase.co';
const env = { SUPABASE_URL: SUPA, GOOGLE_OAUTH_CLIENT_ID: 'apm-google-client', MICROSOFT_OAUTH_CLIENT_ID: 'apm-ms-client' };
const authorize = (redirectTo, extra = '') => `${SUPA}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}&code_challenge=abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_&code_challenge_method=s256&skip_http_redirect=true${extra}`;
const start = (to, provider = 'google') => worker.fetch(new Request(`https://api.aplayermode.com/v1/auth/${provider}/start?to=${encodeURIComponent(to)}`, { redirect: 'manual' }), env);

test('an allowed target: 302 to the same Supabase authorize URL, redirect_to and PKCE passed through', async () => {
  const to = authorize('aplayermode://auth/callback');
  const res = await start(to);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, `${SUPA}/auth/v1/authorize`);
  assert.equal(location.searchParams.get('redirect_to'), 'aplayermode://auth/callback');
  assert.equal(location.searchParams.get('code_challenge'), 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_');
  assert.equal(location.searchParams.get('code_challenge_method'), 's256');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the identity-link Google URL and the calendar connector URLs are allowed', async () => {
  const link = `https://accounts.google.com/o/oauth2/auth?client_id=supabase-google&redirect_uri=${encodeURIComponent(`${SUPA}/auth/v1/callback`)}&state=signed`;
  assert.equal((await start(link)).status, 302);
  const connector = `https://accounts.google.com/o/oauth2/v2/auth?client_id=apm-google-client&redirect_uri=${encodeURIComponent('aplayermode://oauth')}&state=s`;
  assert.equal((await start(connector)).status, 302);
  const ms = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=apm-ms-client&redirect_uri=${encodeURIComponent('aplayermode://oauth')}&state=s`;
  assert.equal((await start(ms, 'microsoft')).status, 302);
});

test('refused targets: 400, no Location (never an open redirect)', async () => {
  const refused = [
    ['https://evil.example/phish', 'google'],
    [authorize('https://evil.example/cb'), 'google'],
    [authorize('aplayermode://auth/callbackX'), 'google'],
    [authorize('aplayermode://auth/callback').replace(SUPA, 'https://other.supabase.co'), 'google'],
    [authorize('aplayermode://auth/callback').replace('/authorize', '/verify'), 'google'],
    [authorize('aplayermode://auth/callback', '&next=https://evil.example'), 'google'],
    [authorize('aplayermode://auth/callback'), 'github'],
    [authorize('aplayermode://auth/callback'), 'microsoft'],
    [authorize('aplayermode://auth/callback').replace('https:', 'http:'), 'google'],
    [`https://accounts.google.com/o/oauth2/v2/auth?client_id=someone-else&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`, 'google'],
    [`https://accounts.google.com/o/oauth2/v2/auth?client_id=apm-google-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`, 'google'],
    [`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=someone-else&redirect_uri=${encodeURIComponent('aplayermode://oauth')}`, 'microsoft'],
  ];
  for (const [to, provider] of refused) {
    const res = await start(to, provider);
    assert.equal(res.status, 400, `${provider} ${to}`);
    assert.equal(res.headers.get('location'), null);
  }
  const missing = await worker.fetch(new Request('https://api.aplayermode.com/v1/auth/google/start', { redirect: 'manual' }), env);
  assert.equal(missing.status, 400);
});
