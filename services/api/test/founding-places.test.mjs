// The PUBLIC Founding 100 count, GET /v1/billing/founding (9 Oct 2026):
//   * no session; answers { total: 100, remaining, open } from the server's count (0062);
//   * under 100 claimed -> open with the real number; at 100 -> remaining 0, open false; a count
//     that reads past the cap (negative / over 100) is clamped, never "open";
//   * an unreadable count answers null / null and is never cached (callers never guess);
//   * aplayermode.com may read it from a browser; cached at the edge for 30 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let entry; let billing;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-founding-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), billing: join(srcDir, 'billing.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  billing = await import(pathToFileURL(join(outDir, 'billing.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', ALLOWED_ORIGIN: 'https://app.aplayermode.com' };
function fakeCount(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('apm_service_billing_founding_spots_left')) {
      calls.push({ apikey: new Headers(init.headers).get('apikey') });
      if (answer === 'error') return new Response('{"message":"down"}', { status: 500 });
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const get = (origin, e = env) => entry.fetch(new Request('https://api.example/v1/billing/founding', { headers: origin ? { origin } : {} }), e, { waitUntil() {}, passThroughOnException() {} });

test('under, at and over 100: open only while places remain; the number is the server count', async () => {
  for (const [count, remaining, open] of [[37, 37, true], [1, 1, true], [100, 100, true], [0, 0, false], [-3, 0, false], [250, 100, true]]) {
    const db = fakeCount(count);
    try {
      const r = await get();
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { total: 100, remaining, open }, `count ${count}`);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
      assert.deepEqual(db.calls, [{ apikey: 'sb_secret_test' }], 'the service credential reads it; no session needed');
    } finally { db.restore(); }
  }
});

test('an unreadable count is null, never cached, never a guess', async () => {
  for (const answer of ['error', 'nope', null]) {
    const db = fakeCount(answer);
    try {
      const r = await get();
      assert.deepEqual(await r.json(), { total: 100, remaining: null, open: null });
      assert.equal(r.headers.get('cache-control'), 'no-store');
    } finally { db.restore(); }
  }
  const { SUPABASE_SECRET_KEY, ...noSecret } = env; void SUPABASE_SECRET_KEY;
  assert.deepEqual(await (await get(undefined, noSecret)).json(), { total: 100, remaining: null, open: null });
  assert.deepEqual(billing.foundingPlacesFrom(Number.NaN), { total: 100, remaining: null, open: null });
});

test('CORS: aplayermode.com may read the count; any other site gets the app origin only', async () => {
  const db = fakeCount(12);
  try {
    const landing = await get('https://aplayermode.com');
    assert.equal(landing.headers.get('access-control-allow-origin'), 'https://aplayermode.com');
    assert.match(landing.headers.get('access-control-allow-methods'), /^GET, OPTIONS$/);
    const other = await get('https://evil.example');
    assert.equal(other.headers.get('access-control-allow-origin'), 'https://app.aplayermode.com');
  } finally { db.restore(); }
});

test('edge cache: a cached count is served without a database read; a null is never stored', async () => {
  const store = new Map();
  const puts = [];
  globalThis.caches = { default: {
    match: async (req) => { const v = store.get(req.url); return v ? new Response(v) : undefined; },
    put: async (req, res) => { puts.push(req.url); store.set(req.url, await res.text()); },
  } };
  try {
    let db = fakeCount('error');
    try { await get(); } finally { db.restore(); }
    assert.equal(puts.length, 0, 'an unreadable count is not cached');
    db = fakeCount(0);
    try { assert.deepEqual(await (await get()).json(), { total: 100, remaining: 0, open: false }); } finally { db.restore(); }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(puts, ['https://api.example/v1/billing/founding']);
    db = fakeCount(50);
    try {
      assert.deepEqual(await (await get()).json(), { total: 100, remaining: 0, open: false }, 'served from the edge for 30 s');
      assert.equal(db.calls.length, 0);
    } finally { db.restore(); }
  } finally { delete globalThis.caches; }
});
