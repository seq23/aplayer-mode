// The name a person types (sign-up, /billing/return for a new OR an existing account, Settings)
// reaches the identity Today greets with: PUT /v1/profile/name upserts user_profiles.display_name
// AS THE USER (RLS: own row only), and getLifeGraph reads it back as identity.displayName.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let entry; let repo;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-profile-name-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), repo: join(srcDir, 'lifeGraphRepository.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  repo = await import(pathToFileURL(join(outDir, 'repo.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-0000000000c1';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A fake Supabase whose user_profiles table is `profiles`; every other read is empty. */
function fakeSupabase(profiles) {
  const writes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (href.endsWith('/auth/v1/user')) return headers.get('authorization') === 'Bearer user-jwt' ? json({ id: USER, email: 'sally@example.com' }) : json({}, 401);
    if (href.includes('/rpc/apm_my_consents')) return json({ ageConfirmedAt: '2026-10-08T00:00:00Z', healthData: null });
    if (href.includes('/rest/v1/user_profiles') && method === 'POST') {
      writes.push({ href, prefer: headers.get('prefer'), auth: headers.get('authorization'), body: JSON.parse(init.body) });
      for (const row of JSON.parse(init.body)) profiles.set(row.user_id, { ...(profiles.get(row.user_id) ?? { timezone: null }), ...row });
      return new Response('', { status: 201 });
    }
    if (href.includes('/rest/v1/user_profiles')) return json([...profiles.values()].filter((p) => href.includes(`user_id=eq.${p.user_id}`)));
    if (href.includes('/rest/v1/rpc/')) return json(null);
    return json([]);
  };
  return { writes, restore: () => { globalThis.fetch = original; } };
}

test('the typed name round-trips: PUT /v1/profile/name -> user_profiles.display_name -> identity.displayName', async () => {
  // A pay-first account the server created has NO name in its profile; an existing one has an old one.
  for (const start of [new Map(), new Map([[USER, { user_id: USER, display_name: 'Old', timezone: 'America/Chicago' }]])]) {
    const fake = fakeSupabase(start);
    try {
      const put = await entry.fetch(new Request('https://api.example/v1/profile/name', {
        method: 'PUT', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify({ displayName: '  Sally ' }),
      }), env, { waitUntil() {} });
      assert.equal(put.status, 200);
      assert.deepEqual(await put.json(), { displayName: 'Sally' });
      assert.equal(fake.writes.length, 1);
      assert.equal(fake.writes[0].auth, 'Bearer user-jwt', 'written as the user (RLS), never with the server key');
      assert.match(fake.writes[0].href, /\/rest\/v1\/user_profiles\?on_conflict=user_id$/);
      assert.match(fake.writes[0].prefer, /resolution=merge-duplicates/);
      assert.equal(fake.writes[0].body[0].user_id, USER);
      const graph = await repo.getLifeGraph(env, 'user-jwt', USER);
      assert.equal(graph.identity.displayName, 'Sally');
    } finally { fake.restore(); }
  }
});

test('the name route: signed in only, a real name only', async () => {
  const fake = fakeSupabase(new Map());
  try {
    const call = (body, auth = 'Bearer user-jwt') => entry.fetch(new Request('https://api.example/v1/profile/name', {
      method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), env, { waitUntil() {} });
    assert.equal((await call({ displayName: 'Sally' }, 'Bearer nope')).status, 401);
    assert.equal((await call({ displayName: '   ' })).status, 400);
    assert.equal((await call({ displayName: 'x'.repeat(61) })).status, 400);
    assert.equal((await call({})).status, 400);
    assert.equal(fake.writes.length, 0);
  } finally { fake.restore(); }
});
