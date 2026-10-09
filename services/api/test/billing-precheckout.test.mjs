// Pay first, account after (docs/33 §10): "Join the Founding 100" opens the card checkout with a
// random checkout id as the RevenueCat app user id, BEFORE any account exists. The claim:
//   * creates the account WITH id = checkout id, so the RevenueCat app user id maps to the account
//     and the webhook, reconcile, portal and Founding 100 paths need no second mapping;
//   * only for a checkout RevenueCat says is paid for NOW (reconcile's filter + sandbox rule);
//   * only with the email the buyer typed at checkout ($email); never for an id an account uses;
//   * applies the paid events through the ONE billing writer, idempotent on retry;
//   * is reachable without a session at POST /v1/billing/precheckout/claim.
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
  outDir = await mkdtemp(join(tmpdir(), 'apm-precheckout-'));
  await build({ entryPoints: { entry: join(srcDir, 'entry.ts'), billing: join(srcDir, 'billing.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  billing = await import(pathToFileURL(join(outDir, 'billing.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const NOW = 1_791_462_000_000;
const env = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
  REVENUECAT_PROJECT_ID: 'proj2c0586cf', REVENUECAT_API_V2_KEY: 'sk_test_key',
};
let n = 0;
const freshId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const sub = (id, overrides = {}) => ({
  id: 'subRcb51d7c42d2e3d89f7b59abf89bdca416f', customer_id: id, product_id: 'prodd268ac7476', store: 'rc_billing', environment: 'production',
  status: 'active', gives_access: true, auto_renewal_status: 'will_renew', current_period_starts_at: NOW - 60_000, current_period_ends_at: NOW + 240_000, ...overrides,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A fake RevenueCat + Supabase auth admin; `users` is the auth.users table. */
function world({ subs = [], paidWith = 'buyer@example.com', users = new Map(), createStatus, rcStatus = 200, ignoreId = false } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const href = String(url); const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ href, method, body: init.body ? JSON.parse(init.body) : undefined, apikey: headers.get('apikey'), auth: headers.get('authorization') });
    if (href.includes('api.revenuecat.com')) {
      if (rcStatus !== 200) return json({}, rcStatus);
      if (href.includes('/subscriptions')) return json({ items: subs });
      if (href.includes('/attributes')) return json({ items: paidWith ? [{ name: '$email', value: paidWith }] : [] });
    }
    const m = href.match(/\/auth\/v1\/admin\/users\/?([^/?]*)$/);
    if (m && method === 'GET') return users.has(m[1]) ? json(users.get(m[1])) : json({ msg: 'User not found' }, 404);
    if (m && method === 'POST') {
      if (createStatus) return json({ msg: 'nope' }, createStatus);
      const body = JSON.parse(init.body);
      if ([...users.values()].some((u) => u.email === body.email)) return json({ code: 'email_exists' }, 422);
      const id = ignoreId ? '00000000-0000-4000-8000-0000000000ff' : body.id;
      users.set(id, { id, email: body.email }); return json({ id, email: body.email });
    }
    if (m && method === 'DELETE') { users.delete(m[1]); return json({}); }
    throw new Error(`unexpected ${method} ${href}`);
  };
  return { fetcher, calls, users };
}

/** The billing writer (supabaseRest uses the global fetch). */
function fakeWriter() {
  const writes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('apm_service_billing_apply_event')) { writes.push(JSON.parse(init.body)); return json({ outcome: 'applied', replayed: false }); }
    return original(url, init);
  };
  return { writes, restore: () => { globalThis.fetch = original; } };
}

test('claim: the account is created WITH the checkout id, then the paid events go through the one writer', async () => {
  const id = freshId();
  const w = world({ subs: [sub(id)] });
  const writer = fakeWriter();
  try {
    const result = await billing.claimPrecheckout(env, { checkoutId: id.toUpperCase(), email: ' Buyer@Example.com ' }, w.fetcher, NOW);
    assert.deepEqual(result, { status: 200, body: { claimed: true, outcomes: ['applied'] } });
    const create = w.calls.find((c) => c.method === 'POST' && c.href.endsWith('/auth/v1/admin/users'));
    assert.deepEqual(create.body, { id, email: 'buyer@example.com', email_confirm: true });
    assert.equal(create.apikey, 'sb_secret_test');
    assert.equal(w.users.get(id).email, 'buyer@example.com');
    // The RevenueCat app user id IS the new account's id: the writer sees it as app_user_id.
    assert.equal(writer.writes.length, 1);
    assert.equal(writer.writes[0].p_event.app_user_id, id);
    assert.equal(writer.writes[0].p_event.product_id, 'apm_web_cos_monthly_founding');
    assert.equal(writer.writes[0].p_allow_sandbox, false);
    assert.ok(w.calls.filter((c) => c.href.includes('revenuecat')).every((c) => c.auth === 'Bearer sk_test_key'));
    // A retry (lost code email) with the same email is fine and idempotent at the writer.
    const again = await billing.claimPrecheckout(env, { checkoutId: id, email: 'buyer@example.com' }, w.fetcher, NOW);
    assert.equal(again.status, 200);
    assert.equal(w.calls.filter((c) => c.method === 'POST' && c.href.endsWith('/auth/v1/admin/users')).length, 1, 'never a second account');
  } finally { writer.restore(); }
});

test('claim refuses: unpaid, other email, used id, existing email, bad input, outages, not configured', async () => {
  const writer = fakeWriter();
  try {
    // Each case on its own checkout id (the per-id rate limit is 6 a minute).
    const refuse = async (mk, input, status, error) => {
      const id = freshId();
      const w = world(mk(id));
      const r = await billing.claimPrecheckout(env, { checkoutId: id, email: 'buyer@example.com', ...input }, w.fetcher, NOW);
      assert.equal(r.status, status, `${error}: ${JSON.stringify(r)}`);
      assert.equal(r.body.error, error);
      assert.equal(w.calls.filter((c) => c.method === 'POST').length, 0, `${error}: no account created`);
    };
    // Nothing paid now (expired, no access, unmapped, someone else's subscription, none at all).
    await refuse(() => ({ subs: [] }), {}, 409, 'not_paid');
    await refuse((id) => ({ subs: [sub(id, { gives_access: false, status: 'expired' })] }), {}, 409, 'not_paid');
    await refuse((id) => ({ subs: [sub(id, { product_id: 'prod_unknown' })] }), {}, 409, 'not_paid');
    await refuse(() => ({ subs: [sub('00000000-0000-4000-8000-0000000009ff')] }), {}, 409, 'not_paid');
    // Sandbox is honoured only for the tester allowlist, exactly as the webhook and reconcile.
    await refuse((id) => ({ subs: [sub(id, { environment: 'sandbox' })] }), {}, 409, 'not_paid');
    // The email must be the one typed at checkout; a missing $email is a mismatch, never a pass.
    await refuse((id) => ({ subs: [sub(id)], paidWith: 'someone@else.com' }), {}, 409, 'email_mismatch');
    await refuse((id) => ({ subs: [sub(id)], paidWith: null }), {}, 409, 'email_mismatch');
    // An id an account already uses with another email is never taken over.
    await refuse((id) => ({ subs: [sub(id)], users: new Map([[id, { id, email: 'owner@example.com' }]]) }), {}, 409, 'already_claimed');
    // Malformed input; RevenueCat down.
    await refuse((id) => ({ subs: [sub(id)] }), { checkoutId: 'not-a-uuid' }, 400, 'invalid_request');
    await refuse((id) => ({ subs: [sub(id)] }), { email: 'nope' }, 400, 'invalid_request');
    await refuse((id) => ({ subs: [sub(id)], rcStatus: 500 }), {}, 502, 'unavailable');
    const id = freshId();
    assert.equal(writer.writes.length, 0, 'no refusal ever writes an entitlement');
    // The email already has an account: named, nothing applied.
    const taken = world({ subs: [sub(id)], users: new Map([['00000000-0000-4000-8000-000000000aaa', { id: 'x', email: 'buyer@example.com' }]]) });
    const r = await billing.claimPrecheckout(env, { checkoutId: id, email: 'buyer@example.com' }, taken.fetcher, NOW);
    assert.deepEqual([r.status, r.body.error], [409, 'email_has_account']);
    assert.match(r.body.message, /support@aplayermode\.com/);
    // An auth server that ignored the requested id: the stray account is removed, fail closed.
    const id2 = freshId();
    const stray = world({ subs: [sub(id2)], ignoreId: true });
    const s = await billing.claimPrecheckout(env, { checkoutId: id2, email: 'buyer@example.com' }, stray.fetcher, NOW);
    assert.equal(s.status, 502);
    assert.equal(stray.users.size, 0);
    assert.equal(writer.writes.length, 0);
    // Not configured: closed.
    const bare = { ...env, REVENUECAT_API_V2_KEY: undefined };
    assert.equal((await billing.claimPrecheckout(bare, { checkoutId: id, email: 'buyer@example.com' }, world().fetcher, NOW)).status, 503);
  } finally { writer.restore(); }
});

test('claim: a sandbox checkout on the tester allowlist is honoured (the one sandbox rule)', async () => {
  const id = freshId();
  const writer = fakeWriter();
  try {
    const w = world({ subs: [sub(id, { environment: 'sandbox' })] });
    const r = await billing.claimPrecheckout({ ...env, BILLING_SANDBOX_TESTER_IDS: id }, { checkoutId: id, email: 'buyer@example.com' }, w.fetcher, NOW);
    assert.equal(r.status, 200);
    assert.equal(writer.writes[0].p_allow_sandbox, true);
  } finally { writer.restore(); }
});

test('claim route: open without a session, rate-limited per checkout id', async () => {
  const id = freshId();
  let limited = 0;
  const limiterEnv = { ...env, RECONCILE_LIMITER: { limit: async ({ key }) => { assert.equal(key, `billing-reconcile:claim:${id}`); limited += 1; return { success: false }; } } };
  const response = await entry.fetch(new Request('https://api.example/v1/billing/precheckout/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkoutId: id, email: 'buyer@example.com' }),
  }), limiterEnv, { waitUntil() {} });
  assert.equal(response.status, 429);
  assert.equal(limited, 1);
  const bad = await entry.fetch(new Request('https://api.example/v1/billing/precheckout/claim', { method: 'POST', body: 'x' }), env, { waitUntil() {} });
  assert.equal(bad.status, 400);
});
