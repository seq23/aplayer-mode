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
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), billing: join(srcDir, 'billing.ts'), policy: fileURLToPath(new URL('../../../packages/policy/src/index.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
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

test('production sandbox: ONLY the explicit tester allowlist is honoured; every other sandbox event stays refused', async () => {
  const TESTER = '00000000-0000-4000-8000-0000000000d7';
  const prod = { ...env, BILLING_SANDBOX_TESTER_IDS: ` ${TESTER.toUpperCase()} , not-a-uuid, ` };
  const fake = fakeSupabase();
  try {
    const sandboxFor = async (overrides, e = prod) => {
      fake.calls.length = 0;
      assert.equal((await post(rcBody(overrides), { authorization: SECRET }, e)).status, 200);
      return fake.calls[0].body.p_allow_sandbox;
    };
    assert.equal(await sandboxFor({ environment: 'SANDBOX', app_user_id: TESTER, store: 'RC_BILLING', product_id: 'apm_web_cos_monthly' }), true, 'listed tester (case-insensitive)');
    assert.equal(await sandboxFor({ environment: 'SANDBOX', app_user_id: USER, store: 'RC_BILLING', product_id: 'apm_web_cos_monthly' }), false, 'a non-listed user stays refused');
    assert.equal(await sandboxFor({ environment: 'SANDBOX', app_user_id: 'not-a-uuid' }), false, 'garbage in the list never matches');
    assert.equal(await sandboxFor({ environment: 'SANDBOX', app_user_id: null }), false, 'no user, no sandbox');
    assert.equal(await sandboxFor({ environment: 'SANDBOX', app_user_id: TESTER }, env), false, 'no allowlist configured = none');
    assert.equal(await sandboxFor({ environment: 'PRODUCTION', app_user_id: TESTER }), false, 'the flag is only ever about sandbox');
    assert.deepEqual([...billing.sandboxTesterIds(prod)], [TESTER]);
  } finally { fake.restore(); }
});

test('web customer portal: session user only, RevenueCat Billing subscriptions only, never throws', async () => {
  const PORTAL = 'https://billing.revenuecat.com/portal/abc';
  const seen = [];
  const rc = (status, body) => async (url, init) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') }); return new Response(JSON.stringify(body), { status }); };
  const cfg = { ...env, REVENUECAT_PROJECT_ID: 'proj2c0586cf', REVENUECAT_API_V2_KEY: 'sk_test_key' };
  assert.deepEqual(await billing.webCustomerPortalFor(env, USER, rc(200, {})), { url: null, reason: 'not_configured' });
  assert.deepEqual(await billing.webCustomerPortalFor({ ...cfg, REVENUECAT_PROJECT_ID: '../x' }, USER, rc(200, {})), { url: null, reason: 'not_configured' });
  const items = [
    { store: 'app_store', management_url: 'https://apps.apple.com/account/subscriptions', starts_at: 9 },
    { store: 'rc_billing', management_url: 'https://billing.revenuecat.com/portal/old', starts_at: 1 },
    { store: 'rc_billing', management_url: PORTAL, starts_at: 5 },
    { store: 'rc_billing', management_url: 'javascript:alert(1)', starts_at: 7 },
  ];
  assert.deepEqual(await billing.webCustomerPortalFor(cfg, USER, rc(200, { items })), { url: PORTAL });
  assert.equal(seen.at(-1).url, `https://api.revenuecat.com/v2/projects/proj2c0586cf/customers/${USER}/subscriptions?limit=20`);
  assert.equal(seen.at(-1).auth, 'Bearer sk_test_key');
  assert.deepEqual(await billing.webCustomerPortalFor(cfg, USER, rc(200, { items: [items[0]] })), { url: null, reason: 'no_web_subscription' });
  assert.deepEqual(await billing.webCustomerPortalFor(cfg, USER, rc(404, {})), { url: null, reason: 'no_web_subscription' });
  assert.deepEqual(await billing.webCustomerPortalFor(cfg, USER, rc(403, {})), { url: null, reason: 'unavailable' });
  assert.deepEqual(await billing.webCustomerPortalFor(cfg, USER, async () => { throw new Error('network'); }), { url: null, reason: 'unavailable' });
  // The route needs a session and asks only about that session's user.
  const fake = fakeSupabase();
  try {
    const get = (headers) => entry.fetch(new Request('https://api.example.com/v1/billing/web/portal', { headers }), env);
    assert.equal((await get({})).status, 401);
    const res = await get({ authorization: 'Bearer user-jwt' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: null, reason: 'not_configured' });
  } finally { fake.restore(); }
});

// Reconcile (8 Oct 2026): a filtered webhook left a paying sandbox tester on 'beta'. Reconcile
// reads the SESSION user's subscriptions from RevenueCat v2 and applies them through the
// webhook's own writer and sandbox rule; it can only grant what RevenueCat says is paid now.
const NOW = 1_791_462_000_000;
const sub = (overrides = {}) => ({
  id: 'subRcb51d7c42d2e3d89f7b59abf89bdca416f', customer_id: USER, product_id: 'prod55a7776fc5', store: 'rc_billing', environment: 'production',
  status: 'active', gives_access: true, auto_renewal_status: 'will_renew', current_period_starts_at: NOW - 60_000, current_period_ends_at: NOW + 240_000, ...overrides,
});

test('reconcile: the v2 product map covers EXACTLY BILLING_PRODUCTS (no product is ever guessed)', async () => {
  const policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
  const mapped = Object.values(billing.REVENUECAT_V2_PRODUCT_IDS).sort();
  assert.deepEqual(mapped, policy.BILLING_PRODUCTS.map((p) => p.productId).sort());
  assert.equal(new Set(mapped).size, mapped.length, 'one RevenueCat id per store product');
  for (const id of Object.keys(billing.REVENUECAT_V2_PRODUCT_IDS)) assert.match(id, /^prod[0-9a-f]{10}$/);
});

test('reconcile: an active web subscription becomes the webhook-shaped grant; lapsed / foreign / unmapped give nothing', () => {
  const [grant, ...rest] = billing.reconcileEventsFor(USER, [sub()], NOW);
  assert.deepEqual(grant, {
    id: `reconcile:subRcb51d7c42d2e3d89f7b59abf89bdca416f:${NOW - 60_000}`, type: 'RENEWAL', app_user_id: USER, product_id: 'apm_web_cos_monthly',
    store: 'RC_BILLING', environment: 'PRODUCTION', event_timestamp_ms: NOW - 60_000, expiration_at_ms: NOW + 240_000,
  });
  assert.equal(rest.length, 0);
  // The grant is exactly what the webhook sanitiser would let through (same writer, same shape).
  assert.deepEqual(billing.sanitizeRevenueCatEvent({ event: grant }), grant);
  assert.equal(billing.reconcileEventsFor(USER, [sub({ store: 'stripe' })], NOW)[0].store, 'STRIPE');
  assert.equal(billing.reconcileEventsFor(USER, [sub({ store: 'play_store', product_id: 'prod6df7e6a266' })], NOW)[0].product_id, 'apm_cos:monthly');
  assert.equal(billing.reconcileEventsFor(USER, [sub({ environment: 'sandbox' })], NOW)[0].environment, 'SANDBOX');
  // Auto-renew off: the grant plus a cancellation (access to period end, not beyond).
  const cancelled = billing.reconcileEventsFor(USER, [sub({ auto_renewal_status: 'will_not_renew' })], NOW);
  assert.deepEqual(cancelled.map((e) => [e.type, e.cancel_reason]), [['RENEWAL', undefined], ['CANCELLATION', 'UNSUBSCRIBE']]);
  // Never a grant for: a lapsed, expired, no-access, other customer's, unmapped or unknown-store subscription.
  for (const bad of [
    sub({ gives_access: false }), sub({ status: 'expired' }), sub({ status: 'in_billing_retry' }), sub({ current_period_ends_at: NOW - 1 }),
    sub({ customer_id: '00000000-0000-4000-8000-000000000999' }), sub({ product_id: 'prod399da46705' }), sub({ store: 'amazon' }),
    sub({ environment: 'staging' }), sub({ id: 'bad id/../' }), sub({ current_period_starts_at: null }),
  ]) assert.deepEqual(billing.reconcileEventsFor(USER, [bad], NOW), [], JSON.stringify(bad));
  // Several subscriptions: the newest live one.
  const two = billing.reconcileEventsFor(USER, [sub({ id: 'old', product_id: 'prod5b26143a3c', current_period_starts_at: NOW - 900_000 }), sub({ id: 'new' })], NOW);
  assert.equal(two[0].product_id, 'apm_web_cos_monthly');
});

test('reconcile: session user only, the webhook writer + sandbox rule, rate-limited, never a client claim', async () => {
  const TESTER = '00000000-0000-4000-8000-0000000000d7';
  const cfg = { ...env, REVENUECAT_PROJECT_ID: 'proj2c0586cf', REVENUECAT_API_V2_KEY: 'sk_test_key' };
  const seen = [];
  const rc = (status, body) => async (url, init) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') }); return new Response(JSON.stringify(body), { status }); };
  assert.deepEqual(await billing.reconcileBillingFor(env, USER, rc(200, {})), { reconciled: false, reason: 'not_configured' });
  assert.deepEqual(await billing.reconcileBillingFor(cfg, 'not-a-uuid', rc(200, {})), { reconciled: false, reason: 'not_configured' });
  const fake = fakeSupabase();
  try {
    const u1 = '00000000-0000-4000-8000-0000000000e1';
    const r1 = await billing.reconcileBillingFor(cfg, u1, rc(200, { items: [sub({ customer_id: u1 })] }), NOW);
    assert.deepEqual(r1, { reconciled: true, outcomes: ['applied'] });
    assert.equal(seen.at(-1).url, `https://api.revenuecat.com/v2/projects/proj2c0586cf/customers/${u1}/subscriptions?limit=20`);
    assert.equal(seen.at(-1).auth, 'Bearer sk_test_key');
    const rpc = fake.calls.filter((c) => c.href.includes('apm_service_billing_apply_event'));
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0].apikey, 'sb_secret_test');
    assert.equal(rpc[0].body.p_event.app_user_id, u1);
    assert.equal(rpc[0].body.p_allow_sandbox, false);
    // Sandbox: honoured ONLY for the tester allowlist — the webhook's rule, not a second one.
    fake.calls.length = 0;
    const withTester = { ...cfg, BILLING_SANDBOX_TESTER_IDS: TESTER };
    await billing.reconcileBillingFor(withTester, TESTER, rc(200, { items: [sub({ customer_id: TESTER, environment: 'sandbox' })] }), NOW);
    const u2 = '00000000-0000-4000-8000-0000000000e2';
    await billing.reconcileBillingFor(withTester, u2, rc(200, { items: [sub({ customer_id: u2, environment: 'sandbox' })] }), NOW);
    assert.deepEqual(fake.calls.filter((c) => c.href.includes('apply_event')).map((c) => [c.body.p_event.app_user_id, c.body.p_allow_sandbox]), [[TESTER, true], [u2, false]]);
    // Nothing paid now: no write at all. RevenueCat down: named, no write.
    fake.calls.length = 0;
    const u3 = '00000000-0000-4000-8000-0000000000e3';
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u3, rc(200, { items: [sub({ customer_id: u3, gives_access: false, status: 'expired' })] }), NOW), { reconciled: false, reason: 'no_active_subscription' });
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u3, rc(404, {}), NOW), { reconciled: false, reason: 'no_active_subscription' });
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u3, rc(500, {}), NOW), { reconciled: false, reason: 'unavailable' });
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u3, async () => { throw new Error('network'); }, NOW), { reconciled: false, reason: 'unavailable' });
    assert.equal(fake.calls.filter((c) => c.href.includes('apply_event')).length, 0);
    // Rate limit: per user, per window (fallback limiter); the binding wins when present.
    const u4 = '00000000-0000-4000-8000-0000000000e4';
    for (let i = 0; i < billing.RECONCILE_LIMIT.requests - 0; i += 1) await billing.reconcileBillingFor(cfg, u4, rc(404, {}), NOW + 1);
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u4, rc(404, {}), NOW + 2), { reconciled: false, reason: 'rate_limited' });
    assert.deepEqual(await billing.reconcileBillingFor(cfg, u4, rc(404, {}), NOW + 2 + billing.RECONCILE_LIMIT.windowMs), { reconciled: false, reason: 'no_active_subscription' });
    const keys = [];
    const limited = { ...cfg, RECONCILE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
    assert.deepEqual(await billing.reconcileBillingFor(limited, u1, rc(200, { items: [sub({ customer_id: u1 })] }), NOW), { reconciled: false, reason: 'rate_limited' });
    assert.deepEqual(keys, [`billing-reconcile:${u1}`]);
  } finally { fake.restore(); }
  // The route: a session is required, the user is the session's (a body naming another user is ignored), 429 when limited.
  const fake2 = fakeSupabase();
  const original = globalThis.fetch;
  const rcCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.revenuecat.com/')) { rcCalls.push(String(url)); return new Response(JSON.stringify({ items: [sub({ current_period_starts_at: Date.now() - 60_000, current_period_ends_at: Date.now() + 30 * 86_400_000 })] }), { status: 200 }); }
    return original(url, init);
  };
  try {
    const call = (headers, e = cfg) => entry.fetch(new Request('https://api.example.com/v1/billing/reconcile', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ userId: TESTER, plan: 'autopilot' }) }), e);
    assert.equal((await call({})).status, 401);
    const res = await call({ authorization: 'Bearer user-jwt' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reconciled: true, outcomes: ['applied'] });
    assert.ok(rcCalls.at(-1).includes(`/customers/${USER}/`), 'the session user, never the body');
    const applied = fake2.calls.find((c) => c.href.includes('apply_event'));
    assert.equal(applied.body.p_event.app_user_id, USER);
    assert.equal(applied.body.p_event.product_id, 'apm_web_cos_monthly', 'the product comes from RevenueCat, never the request');
    assert.equal((await call({ authorization: 'Bearer user-jwt' }, { ...cfg, RECONCILE_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
    assert.ok(!fake2.calls.some((c) => c.href.includes('subscription_entitlements') && c.method !== 'GET'), 'nothing writes the entitlement table directly');
  } finally { globalThis.fetch = original; fake2.restore(); }
});
