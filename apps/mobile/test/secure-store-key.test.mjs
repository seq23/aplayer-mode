// The sign-in storage must only ever ask iOS SecureStore for keys it accepts; one bad key left
// the app stuck on its loading screen (simulator, 14 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const VALID = /^[A-Za-z0-9._-]+$/;

test('every SecureStore key the sign-in storage builds is one iOS accepts', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'apm-securekey-'));
  try {
    await build({ entryPoints: { k: join(appDir, 'src/auth/secureKey.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
    const { secureStoreKey } = await import(pathToFileURL(join(outDir, 'k.js')).href);
    for (const key of ['sb-abcdefghijklmnop-auth-token', 'sb-x-auth-token-code-verifier', 'odd key:with/chars@']) {
      for (const part of ['meta', 0, 7, 12]) assert.match(secureStoreKey(key, part), VALID, `${key} / ${part}`);
    }
    assert.notEqual(secureStoreKey('a', 'meta'), secureStoreKey('a', 0), 'parts stay distinct');
  } finally { await rm(outDir, { recursive: true, force: true }); }
});

test('the storage adapter builds every key through secureStoreKey, never by hand', async () => {
  const code = await readFile(join(appDir, 'src/auth/supabase.ts'), 'utf8');
  const calls = code.match(/SecureStore\.(get|set|delete)ItemAsync\(([^,)]+)/g) ?? [];
  assert.ok(calls.length >= 6, `found ${calls.length} SecureStore calls`);
  for (const c of calls) assert.match(c, /\(secureStoreKey\(/, c);
});
