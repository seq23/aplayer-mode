// HEAD must answer like GET without a body, on every GET route of the deployed
// Worker entry (entry.ts), /v1/health included. Uptime monitors send HEAD;
// before the fix HEAD /v1/health returned 500 because the health wrapper parsed
// the empty HEAD body as JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'apm-head-'));
await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), index: join(srcDir, 'index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent', define: { __APM_BUILD_SHA__: "'test-sha'", __APM_RUNTIME_ENVIRONMENT__: "'production'" } });
const worker = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
const app = (await import(pathToFileURL(join(outDir, 'index.js')).href)).default;
test.after(() => rm(outDir, { recursive: true, force: true }));

const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };

test('HEAD /v1/health returns 200 with no body; GET keeps ok:true and the build identity', async () => {
  const head = await worker.fetch(new Request('https://api.test/v1/health', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(await head.text(), '');
  assert.match(head.headers.get('content-type') ?? '', /application\/json/);

  const get = await worker.fetch(new Request('https://api.test/v1/health'), env);
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.ok, true);
  assert.equal(body.buildSha, 'test-sha');
  assert.equal(body.runtimeEnvironment, 'production');
});

test('every GET route answers HEAD with the GET status and no body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const paths = [...new Set(app.routes.filter((r) => r.method === 'GET' && !r.path.includes('*')).map((r) => r.path.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000')))];
    assert.ok(paths.length >= 10, `expected the GET route table, found ${paths.length}`);
    for (const path of paths) {
      const get = await worker.fetch(new Request(`https://api.test${path}`), env);
      await get.body?.cancel();
      const head = await worker.fetch(new Request(`https://api.test${path}`, { method: 'HEAD' }), env);
      assert.equal(head.status, get.status, `HEAD ${path} status matches GET`);
      assert.notEqual(head.status, 500, `HEAD ${path} must not 500`);
      assert.equal(await head.text(), '', `HEAD ${path} has no body`);
    }
  } finally { globalThis.fetch = realFetch; }
});
