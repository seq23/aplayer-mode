// The RevenueCat webhook and the billing routes end to end against a fake Supabase:
//   * the webhook is closed (503) until a >= 32-char secret and the service key exist;
//   * the Authorization secret is checked in constant time BEFORE anything is parsed;
//   * only allow-listed event fields reach the database (no subscriber attributes, no
//     client-claimed entitlements), written with the server-only key;
//   * malformed / oversized bodies are refused; a database outage is a 500 (RevenueCat retries);
//   * the offering route takes the user id from the verified session, never from the request;
//   * no route accepts a client-reported purchase; the cron runs the expiry sweep.
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
  outDir = await mkdtemp(join(tmpdir(), 'apm-billing-worker-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), billing: join(srcDir, 'billing.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  billing = await import(pathToFileURL(join(outDir, 'billing.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const SECRET = 'rc_whsec_0123456789abcdef0123456789abcdef';
const USER = '00000000-0000-4000-8000-0000000000c1';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', REVENUECAT_WEBHOOK_SECRET: SECRET };

function fakeSupabase({ rpcStatus = 200, rpcBody = { outcome: 'applied', replayed: false } } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const headers = new Headers(init.headers);
    calls.push({ href, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, apikey: headers.get('apikey'), authorization: headers.get('authorization') });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (href.endsWith('/auth/v1/user')) return headers.get('authorization') === 'Bearer user-jwt' ? json({ id: USER }) : json({ message: 'bad jwt' }, 401);
    if (href.includes('/rest/v1/rpc/apm_service_billing_offering')) return json({ offering: 'founding', founding: false, reservedUntil: '2026-10-07T13:00:00Z' });
    if (href.includes('/rest/v1/rpc/apm_service_billing_expire_lapsed')) return json(2);
    if (href.includes('/rest/v1/rpc/apm_service_billing_apply_event')) return json(rpcBody, rpcStatus);
    return json({ message: `unexpected ${href}` }, 500);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const rcBody = (overrides = {}) => ({
  api_version: '1.0',
  event: {
    id: 'evt-abc', type: 'INITIAL_PURCHASE', app_user_id: USER, original_app_user_id: USER, aliases: [USER],
    product_id: 'apm_cos_monthly', entitlement_ids: ['autopilot'], period_type: 'INTRO', store: 'APP_STORE', environment: 'PRODUCTION',
    event_timestamp_ms: 1_791_000_000_000, purchased_at_ms: 1_791_000_000_000, expiration_at_ms: 1_793_600_000_000,
    price: 9.99, currency: 'USD', subscriber_attributes: { $email: { value: 'person@example.com' } }, transaction_id: 't1', ...overrides,
  },
});
const post = (body, headers = {}, e = env) => entry.fetch(new Request('https://api.example.com/v1/billing/revenuecat/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), e);

test('constant-time secret check: exact match only, any length', async () => {
  assert.equal(await billing.verifyWebhookAuthorization(SECRET, SECRET), true);
  assert.equal(await billing.verifyWebhookAuthorization(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(await billing.verifyWebhookAuthorization(`${SECRET.slice(0, -1)}X`, SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization(`${SECRET}x`, SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization(SECRET.slice(0, 10), SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization(`bearer ${SECRET}`, SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization('', SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization(null, SECRET), false);
  assert.equal(await billing.verifyWebhookAuthorization('short', 'short'), false, 'a short secret is never accepted');
  assert.equal(await billing.verifyWebhookAuthorization(undefined, undefined), false);
});

test('the webhook is closed until it is configured (named 503, nothing written)', async () => {
  const fake = fakeSupabase();
  try {
    for (const e of [{ ...env, REVENUECAT_WEBHOOK_SECRET: undefined }, { ...env, REVENUECAT_WEBHOOK_SECRET: 'too-short' }, { ...env, SUPABASE_SECRET_KEY: undefined }]) {
      const res = await post(rcBody(), { authorization: e.REVENUECAT_WEBHOOK_SECRET ?? '' }, e);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'billing_webhook_not_configured' });
    }
    assert.equal(fake.calls.length, 0);
  } finally { fake.restore(); }
});

test('a wrong or missing secret is 401 before the body is even parsed', async () => {
  const fake = fakeSupabase();
  try {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Bearer  ${SECRET}` }, { authorization: `Basic ${SECRET}` }, { authorization: 'Bearer user-jwt' }]) {
      const res = await post('{not json', headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    assert.equal(fake.calls.length, 0, 'no database call, no auth call');
  } finally { fake.restore(); }
});

test('a verified event reaches the database allow-listed, with the server-only key', async () => {
  const fake = fakeSupabase();
  try {
    const res = await post(rcBody(), { authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, outcome: 'applied', replayed: false });
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.match(call.href, /\/rest\/v1\/rpc\/apm_service_billing_apply_event$/);
    assert.equal(call.apikey, 'sb_secret_test');
    assert.deepEqual(call.body, {
      p_event: { id: 'evt-abc', type: 'INITIAL_PURCHASE', app_user_id: USER, product_id: 'apm_cos_monthly', store: 'APP_STORE', environment: 'PRODUCTION', event_timestamp_ms: 1_791_000_000_000, expiration_at_ms: 1_793_600_000_000, period_type: 'INTRO' },
      p_allow_sandbox: false,
    });
    const sent = JSON.stringify(call.body);
    for (const leaked of ['entitlement_ids', 'subscriber_attributes', 'person@example.com', 'price', 'aliases']) assert.ok(!sent.includes(leaked), `${leaked} never reaches the database`);
    // Raw secret header form works too; sandbox is only allowed when staging says so.
    fake.calls.length = 0;
    assert.equal((await post(rcBody({ environment: 'SANDBOX' }), { authorization: SECRET }, { ...env, BILLING_ALLOW_SANDBOX: 'true' })).status, 200);
    assert.equal(fake.calls[0].body.p_allow_sandbox, true);
  } finally { fake.restore(); }
});

test('malformed, oversized and database-refused bodies; outages are retryable 500s', async () => {
  let fake = fakeSupabase();
  try {
    const auth = { authorization: SECRET };
    assert.equal((await post('{not json', auth)).status, 400);
    assert.equal((await post({ nothing: true }, auth)).status, 400);
    assert.equal((await post(rcBody({ id: '' }), auth)).status, 400);
    assert.equal((await post(rcBody({ type: 'initial purchase' }), auth)).status, 400);
    assert.equal((await post(rcBody({ event_timestamp_ms: 'yesterday' }), auth)).status, 400);
    assert.equal((await post(rcBody({ product_id: { $ne: null } }), auth)).status, 400);
    assert.equal((await post(JSON.stringify({ event: { id: 'x', pad: 'y'.repeat(70 * 1024) } }), auth)).status, 413);
    assert.equal(fake.calls.length, 0);
  } finally { fake.restore(); }
  fake = fakeSupabase({ rpcStatus: 400, rpcBody: { code: '22023', message: 'billing_invalid_event' } });
  try { assert.equal((await post(rcBody(), { authorization: SECRET })).status, 400); } finally { fake.restore(); }
  fake = fakeSupabase({ rpcStatus: 503, rpcBody: { message: 'db down' } });
  try { assert.equal((await post(rcBody(), { authorization: SECRET })).status, 500); } finally { fake.restore(); }
});

test('the offering comes from the server for the SESSION user; no route takes a client purchase', async () => {
  const fake = fakeSupabase();
  try {
    assert.equal((await entry.fetch(new Request('https://api.example.com/v1/billing/offering'), env)).status, 401);
    const res = await entry.fetch(new Request(`https://api.example.com/v1/billing/offering?userId=${'0'.repeat(8)}-0000-4000-8000-000000000999`, { headers: { authorization: 'Bearer user-jwt' } }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.offeringId, 'founding');
    assert.equal(body.appUserId, USER);
    const rpc = fake.calls.find((c) => c.href.includes('apm_service_billing_offering'));
    assert.deepEqual(rpc.body, { p_user_id: USER }, 'user id from the verified JWT, never the query');
    assert.equal(rpc.apikey, 'sb_secret_test');
    assert.ok(body.products.some((p) => p.offer === 'founding'));
    for (const path of ['/v1/billing/purchase', '/v1/billing/receipt', '/v1/billing/entitlement', '/v1/billing/restore']) {
      const r = await entry.fetch(new Request(`https://api.example.com${path}`, { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'autopilot' }) }), env);
      assert.equal(r.status, 404, `${path} does not exist`);
    }
    assert.ok(!fake.calls.some((c) => c.href.includes('subscription_entitlements') && c.method !== 'GET'), 'nothing writes the entitlement table directly');
  } finally { fake.restore(); }
});

test('the cron runs the billing expiry sweep; without the service key it is a named skip', async () => {
  const fake = fakeSupabase();
  try {
    assert.deepEqual(await billing.runBillingSweep(env), { expired: 2 });
    assert.deepEqual(await billing.runBillingSweep({ ...env, SUPABASE_SECRET_KEY: undefined }), { skipped: 'no_service_credential', expired: 0 });
    const pending = [];
    await entry.scheduled({ scheduledTime: Date.parse('2026-10-07T03:00:00Z'), cron: '*/15 * * * *' }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.allSettled(pending);
    assert.ok(fake.calls.some((c) => c.href.includes('apm_service_billing_expire_lapsed')), 'scheduled() runs the sweep');
  } finally { fake.restore(); }
});
