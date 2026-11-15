// Sign-in options (owner call 14 Nov 2026): Apple on, Google hidden behind one flag until the
// Supabase project enables it; a provider that is not enabled reads as a plain sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'apm-sign-in-options-'));
await build({ entryPoints: { signInOptions: join(appDir, 'src/auth/signInOptions.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
const m = await import(pathToFileURL(join(outDir, 'signInOptions.js')).href);
test.after(() => rm(outDir, { recursive: true, force: true }));

test('the flag hides Google on every platform; Apple stays on iOS and email always', () => {
  assert.equal(m.GOOGLE_SIGN_IN_ENABLED, false);
  assert.deepEqual(m.signInOptions('ios'), ['apple', 'email']);
  assert.deepEqual(m.signInOptions('web'), ['email']);
  assert.deepEqual(m.signInOptions('android'), ['email']);
  // Turning the flag on brings Google back after Apple, before email.
  assert.deepEqual(m.signInOptions('ios', true), ['apple', 'google', 'email']);
  assert.deepEqual(m.signInOptions('web', true), ['google', 'email']);
});

test('the account panel renders only the options the flag allows', async () => {
  const panel = await readFile(join(appDir, 'src/components/intake/AccountPanel.tsx'), 'utf8');
  assert.match(panel, /const options = signInOptions\(Platform\.OS\)/);
  assert.match(panel, /options\.includes\('google'\) \? <Button label=\{busy === 'google'/);
  assert.match(panel, /options\.includes\('apple'\) \? <AppleButton/);
});

test('provider not enabled: a plain sentence naming the provider, never the raw error', () => {
  const raw = Object.assign(new Error('Unsupported provider: provider is not enabled'), { code: 'validation_failed', status: 400 });
  assert.equal(m.friendlyAuthError(raw, 'apple'), "Apple sign-in isn't available yet. Use your email instead.");
  assert.equal(m.friendlyAuthError({ code: 'provider_disabled', message: 'x' }, 'apple'), "Apple sign-in isn't available yet. Use your email instead.");
  assert.equal(m.friendlyAuthError(raw, 'google'), "Google sign-in isn't available yet. Use your email instead.");
  assert.doesNotMatch(m.friendlyAuthError(raw), /Unsupported|provider/i);
  // Other failures keep their existing words.
  assert.equal(m.friendlyAuthError(new Error('Token has expired or is invalid'), 'apple'), "That code didn't match. Try again or resend.");
  assert.equal(m.friendlyAuthError(new Error('boom'), 'apple'), "That didn't work. Try again, or use another way to save.");
});

test('Apple sign-in failures go through the mapping with the provider named', async () => {
  const session = await readFile(join(appDir, 'src/state/session.tsx'), 'utf8');
  const apple = session.slice(session.indexOf('signInWithApple: async'), session.indexOf('signInWithGoogle: async'));
  assert.match(apple, /return fail\(cause, 'apple'\)/);
  assert.match(session, /friendlyAuthError\(cause, provider\)/);
});
