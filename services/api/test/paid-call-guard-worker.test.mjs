// The paid-call guard (src/paidCalls.ts), end to end through the Worker: a billed model call
// needs a verified session (401 without), a route that can reach one answers 429 over the per-user
// burst limit, and the per-user and global daily ceilings stop the provider call itself (the
// caller keeps its deterministic answer). A ceiling that cannot be read refuses the call.
// Unauthenticated routes that guard a secret or a third-party quota are limited per IP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let entry; let limits;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-paid-guard-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), paid: join(srcDir, 'paidCalls.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  limits = (await import(pathToFileURL(join(outDir, 'paid.js')).href)).PAID_CALL_LIMITS;
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-000000000001';
const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };
const env = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
  OPENROUTER_API_KEY: 'sk-or-test', PAID_CALL_LIMITER: allow, RECONCILE_LIMITER: allow,
};
const routeRow = { route_id: 'r', model_id: 'v/m', provider_id: 'V', status: 'approved', cost_class: 'standard', capabilities: ['extraction', 'reasoning', 'structured_output'],
  data_classes_allowed: ['private_life'], training_allowed: false, retention: 'zero', approved_for_highly_sensitive: false, quality_score: 90, reliability_score: 90, latency_score: 90,
  last_policy_reviewed_at: '2026-10-06T00:00:00Z', last_eval_run_at: null };

function harness({ mine = 0, all = 0, countStatus = 206 } = {}) {
  const calls = { openrouter: 0, counts: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); const method = init.method ?? 'GET'; const headers = new Headers(init.headers);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (href.endsWith('/auth/v1/user')) return headers.get('authorization') === 'Bearer user-jwt' ? json({ id: USER }) : json({ message: 'bad jwt' }, 401);
    if (href.includes('/rest/v1/rpc/apm_my_consents')) return json({ ageConfirmedAt: '2026-10-08T00:00:00Z', healthData: null });
    if (href.includes('/rest/v1/model_routes')) return json([routeRow]);
    if (href.includes('/rest/v1/ai_usage_events') && method === 'HEAD') {
      assert.equal(headers.get('apikey'), env.SUPABASE_SECRET_KEY, 'the ceiling is counted with the service key, across every user');
      const perUser = href.includes('user_id=eq.');
      calls.counts.push(perUser ? 'user' : 'global');
      return new Response(null, { status: countStatus, headers: { 'content-range': `0-0/${perUser ? mine : all}` } });
    }
    if (href.includes('/rest/v1/ai_usage_events')) return new Response(null, { status: 201 });
    if (href.includes('/rest/v1/analytics_events')) return new Response(null, { status: 201 });
    if (href.startsWith('https://openrouter.ai/')) {
      calls.openrouter += 1;
      return json({ choices: [{ message: { content: JSON.stringify({ trackKeys: [], floors: {}, extracted: { boundaries: [], deadlines: [], commitments: [], radarSeeds: [] }, suggestedAreas: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.00001 } });
    }
    throw new Error(`unexpected ${method} ${href}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const synth = (headers = {}, e = env) => entry.fetch(new Request('https://api.example.com/v1/intake/synthesis', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ catchAll: 'I want to run a 10k', games: ['athlete'], trackKeys: [], floors: {} }),
}), e);
const auth = { authorization: 'Bearer user-jwt' };

test('paid routes: no session → 401, over the burst limit → 429, a real user → the model is called once', async () => {
  const h = harness();
  try {
    assert.equal((await synth()).status, 401);
    assert.equal((await synth({ authorization: 'Bearer forged' })).status, 401);
    assert.equal((await synth({ apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}` })).status, 401, 'the publishable key is not a session');
    for (const path of ['/v1/intake/synthesis', '/v1/apm/coach', '/v1/email/connections/11111111-1111-4111-8111-111111111111/sync']) {
      const res = await entry.fetch(new Request(`https://api.example.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{}' }), { ...env, PAID_CALL_LIMITER: deny });
      assert.equal(res.status, 429, path);
    }
    assert.equal(h.calls.openrouter, 0, 'nothing billed before the passing call');
    const ok = await synth(auth);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).source, 'model');
    assert.equal(h.calls.openrouter, 1);
    assert.deepEqual(h.calls.counts.sort(), ['global', 'user'], 'both daily ceilings were read before the call');
  } finally { h.restore(); }
});

test('daily ceilings: per user, global, and an unreadable count each stop the provider call; the user keeps the deterministic answer', async () => {
  for (const [name, opts] of [
    ['per-user', { mine: limits.perUserPerDay }],
    ['global', { all: limits.globalPerDay }],
    ['unreadable', { countStatus: 500 }],
  ]) {
    const h = harness(opts);
    try {
      const res = await synth(auth);
      assert.equal(res.status, 200, name);
      assert.equal((await res.json()).source, 'deterministic', name);
      assert.equal(h.calls.openrouter, 0, `${name}: no billed call`);
    } finally { h.restore(); }
  }
  const h = harness({ mine: limits.perUserPerDay - 1, all: limits.globalPerDay - 1 });
  try { assert.equal((await (await synth(auth)).json()).source, 'model', 'one under both ceilings still runs'); assert.equal(h.calls.openrouter, 1); }
  finally { h.restore(); }
});

test('unauthenticated secret/quota routes are limited per IP: review sign-in and pay-first claim → 429 before any lookup', async () => {
  const h = harness();
  try {
    const limited = { ...env, RECONCILE_LIMITER: deny, APP_REVIEW_EMAIL: 'appreview@aplayermode.com', APP_REVIEW_CODE: '12345678' };
    const review = await entry.fetch(new Request('https://api.example.com/v1/auth/review-login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ email: 'appreview@aplayermode.com', code: '00000000' }) }), limited);
    assert.equal(review.status, 429);
    const claim = await entry.fetch(new Request('https://api.example.com/v1/billing/precheckout/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ checkoutId: '22222222-2222-4222-8222-222222222222', email: 'a@b.co' }) }), limited);
    assert.equal(claim.status, 429);
  } finally { h.restore(); }
});
