// Web sign-in sheets (retest 14 Nov 2026): a native build opens our own start URL first (so iOS
// names aplayermode.com), and the button resets the moment the sheet comes back cancelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'apm-auth-sheet-'));
await build({ entryPoints: { authStart: join(appDir, 'src/integrations/authStart.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
const m = await import(pathToFileURL(join(outDir, 'authStart.js')).href);
test.after(() => rm(outDir, { recursive: true, force: true }));
const src = (path) => readFile(join(appDir, path), 'utf8');

const SUPA = 'https://proj.supabase.co/auth/v1/authorize?provider=google&redirect_to=aplayermode%3A%2F%2Fauth%2Fcallback';
const API = 'https://api.aplayermode.com';

test('a native build opens the start URL on our domain, carrying the exact sign-in URL', () => {
  const url = new URL(m.authStartUrl(SUPA, { provider: 'google', returnUrl: 'aplayermode://auth/callback', apiBase: `${API}/`, platform: 'ios' }));
  assert.equal(url.origin, API);
  assert.equal(url.pathname, '/v1/auth/google/start');
  assert.equal(url.searchParams.get('to'), SUPA);
  // Web keeps its popup; a dev build's exp:// return and a missing API stay direct.
  assert.equal(m.authStartUrl(SUPA, { provider: 'google', returnUrl: 'aplayermode://auth/callback', apiBase: API, platform: 'web' }), SUPA);
  assert.equal(m.authStartUrl(SUPA, { provider: 'google', returnUrl: 'exp://192.168.1.2:8081/--/auth/callback', apiBase: API, platform: 'ios' }), SUPA);
  assert.equal(m.authStartUrl(SUPA, { provider: 'google', returnUrl: 'aplayermode://auth/callback', apiBase: undefined, platform: 'ios' }), SUPA);
});

test('cancel or dismiss: the button is released at once; success: it is not', async () => {
  for (const type of ['cancel', 'dismiss', 'locked']) {
    let released = 0;
    const out = await m.openAuthSheet(async () => ({ type }), 'https://x', 'aplayermode://auth/callback', () => { released += 1; });
    assert.equal(out, null);
    assert.equal(released, 1, `${type} releases the button`);
  }
  let released = 0;
  const out = await m.openAuthSheet(async () => ({ type: 'success', url: 'aplayermode://auth/callback?code=c' }), 'https://x', 'aplayermode://auth/callback', () => { released += 1; });
  assert.equal(out, 'aplayermode://auth/callback?code=c');
  assert.equal(released, 0);
});

test('the Google button and both sheets are wired through the helpers', async () => {
  const panel = await src('src/components/intake/AccountPanel.tsx');
  assert.match(panel, /run\('google', \(release\) => signInWithGoogle\(\{ onSheetClosed: release \}\)\)/);
  const session = await src('src/state/session.tsx');
  assert.match(session, /openAuthSheet\(WebBrowser\.openAuthSessionAsync, start, redirectTo, options\?\.onSheetClosed\)/);
  const oauth = await src('src/integrations/oauth.ts');
  assert.match(oauth, /openAuthSheet\(WebBrowser\.openAuthSessionAsync, start, redirectUri\)/);
  for (const file of [session, oauth]) assert.doesNotMatch(file, /WebBrowser\.openAuthSessionAsync\(/, 'no sheet opens a raw provider URL');
});
