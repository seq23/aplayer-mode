// Pay first, account after (docs/33 §10): "Join the Founding 100" opens the card checkout with a
// random checkout id as the RevenueCat app user id, BEFORE any account exists. The claim:
//   * creates the account WITH id = checkout id, so the RevenueCat app user id maps to the account
//     and the webhook, reconcile, portal and Founding 100 paths need no second mapping;
//   * only for a checkout RevenueCat says is paid for NOW (reconcile's filter + sandbox rule);
//   * only with the email the buyer typed at checkout ($email); never for an id an account uses;
//   * applies the paid events through the ONE billing writer, idempotent on retry;
//   * is reachable without a session at POST /v1/billing/precheckout/claim;
//   * for an email that ALREADY has an account (0096) grants NOTHING: the buyer proves the inbox
//     with the 6-digit code, then the SIGNED-IN session attaches it (POST .../precheckout/attach),
//     which links checkout id -> that account once and applies the events through the one writer.
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
function world({ subs = [], paidWith = 'buyer@example.com', users = new Map(), links = new Map(), createStatus, rcStatus = 200, ignoreId = false } = {}) {
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
    // The 0096 link functions, with the database's own rules (billing-db.test.mjs runs the real SQL).
    if (href.endsWith('/rest/v1/rpc/apm_service_billing_checkout_owner')) return json(links.get(JSON.parse(init.body).p_checkout_id) ?? null);
    if (href.endsWith('/rest/v1/rpc/apm_service_billing_checkout_ids')) { const u = JSON.parse(init.body).p_user_id; return json([...links].filter(([, owner]) => owner === u).map(([c]) => c)); }
    if (href.endsWith('/rest/v1/rpc/apm_service_billing_link_checkout')) {
      const { p_checkout_id: c, p_user_id: u, p_email: e } = JSON.parse(init.body);
      if ((users.get(u)?.email ?? '').toLowerCase() !== String(e).toLowerCase()) return json({ linked: false, reason: 'email_mismatch' });
      if (users.has(c)) return json({ linked: false, reason: 'already_claimed' });
      if (links.has(c)) return json(links.get(c) === u ? { linked: true, replayed: true } : { linked: false, reason: 'already_claimed' });
      links.set(c, u); return json({ linked: true, replayed: false });
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
  return { fetcher, calls, users, links };
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
      assert.equal(w.calls.filter((c) => c.method === 'POST' && c.href.includes('/auth/v1/admin/users')).length, 0, `${error}: no account created`);
      assert.equal(w.links.size, 0, `${error}: no link`);
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
    // The email already has an account: no refusal any more (0096), but the claim alone grants
    // NOTHING: no write, no link; the client must now prove the inbox and attach while signed in.
    const taken = world({ subs: [sub(id)], users: new Map([['00000000-0000-4000-8000-000000000aaa', { id: 'x', email: 'buyer@example.com' }]]) });
    const r = await billing.claimPrecheckout(env, { checkoutId: id, email: 'buyer@example.com' }, taken.fetcher, NOW);
    assert.deepEqual(r, { status: 200, body: { claimed: true, outcomes: [], existingAccount: true } });
    assert.equal(taken.links.size, 0);
    assert.ok(!taken.calls.some((c) => c.href.includes('link_checkout')), 'the claim never links');
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

// ------------------------------------------------------------ 0096: the email already has an account
const EXISTING = '00000000-0000-4000-8000-00000000e1e1';
const existingWorld = (id, extra = {}) => world({ subs: [sub(id, extra.sub)], users: new Map([[EXISTING, { id: EXISTING, email: 'buyer@example.com' }], ...(extra.users ?? [])]), ...extra.world });

test('existing account: claim grants nothing; the signed-in session (code proven) attaches the checkout to THAT account', async () => {
  const id = freshId();
  const w = existingWorld(id);
  const writer = fakeWriter();
  try {
    const claim = await billing.claimPrecheckout(env, { checkoutId: id, email: 'Buyer@Example.com' }, w.fetcher, NOW);
    assert.equal(claim.body.existingAccount, true);
    assert.equal(writer.writes.length, 0, 'claim alone: no entitlement');
    assert.equal(w.links.size, 0, 'claim alone: no link');
    assert.ok(!w.users.has(id), 'never a second account');
    // After the 6-digit code: the session is the existing account, with its verified email.
    const r = await billing.attachPrecheckout(env, { id: EXISTING, email: 'BUYER@example.com' }, { checkoutId: id.toUpperCase() }, w.fetcher, NOW);
    assert.deepEqual(r, { status: 200, body: { attached: true, outcomes: ['applied'] } });
    assert.equal(w.links.get(id), EXISTING);
    const link = w.calls.find((c) => c.href.endsWith('/rpc/apm_service_billing_link_checkout'));
    assert.deepEqual(link.body, { p_checkout_id: id, p_user_id: EXISTING, p_email: 'buyer@example.com' });
    assert.equal(link.apikey, 'sb_secret_test');
    // The event keeps the checkout id (and its sandbox rule); the database follows the link.
    assert.equal(writer.writes.length, 1);
    assert.equal(writer.writes[0].p_event.app_user_id, id);
    assert.equal(writer.writes[0].p_event.product_id, 'apm_web_cos_monthly_founding');
    // The link is written BEFORE anything is applied.
    const order = w.calls.map((c) => c.href).filter((h) => h.includes('/rpc/'));
    assert.deepEqual(order, [`${env.SUPABASE_URL}/rest/v1/rpc/apm_service_billing_checkout_owner`, `${env.SUPABASE_URL}/rest/v1/rpc/apm_service_billing_link_checkout`]);
  } finally { writer.restore(); }
});

test('existing account: without the proven email nothing attaches (no session, other email, other $email, unpaid)', async () => {
  const writer = fakeWriter();
  try {
    // No session: the route refuses before anything is read.
    const id0 = freshId();
    const noSession = await entry.fetch(new Request('https://api.example/v1/billing/precheckout/attach', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkoutId: id0 }),
    }), env, { waitUntil() {} });
    assert.equal(noSession.status, 401);
    const cases = [
      // Signed in as someone whose verified email is NOT the one paid with (the guard).
      [{ id: '00000000-0000-4000-8000-00000000e2e2', email: 'attacker@example.com' }, {}, 409, 'email_mismatch'],
      // A session with no verified email.
      [{ id: EXISTING }, {}, 409, 'email_mismatch'],
      // The checkout's $email is someone else's.
      [{ id: EXISTING, email: 'buyer@example.com' }, { world: { paidWith: 'other@example.com' } }, 409, 'email_mismatch'],
      // Not paid for now.
      [{ id: EXISTING, email: 'buyer@example.com' }, { sub: { gives_access: false, status: 'expired' } }, 409, 'not_paid'],
      // Sandbox off the tester allowlist.
      [{ id: EXISTING, email: 'buyer@example.com' }, { sub: { environment: 'sandbox' } }, 409, 'not_paid'],
    ];
    for (const [user, extra, status, error] of cases) {
      const id = freshId();
      const w = existingWorld(id, extra);
      const r = await billing.attachPrecheckout(env, user, { checkoutId: id }, w.fetcher, NOW);
      assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify([user, extra]));
      assert.equal(w.links.size, 0, `${error}: no link`);
      assert.ok(!w.calls.some((c) => c.href.includes("link_checkout")), `${error}: the Worker refuses before asking the database to link`);
    }
    // The database's own email re-check refuses too, even if the Worker's check were bypassed.
    const id = freshId();
    const w = existingWorld(id);
    w.users.set(EXISTING, { id: EXISTING, email: 'changed@example.com' });
    const r = await billing.attachPrecheckout(env, { id: EXISTING, email: 'buyer@example.com' }, { checkoutId: id }, w.fetcher, NOW);
    assert.deepEqual([r.status, r.body.error], [409, 'email_mismatch']);
    // Its own id, or garbage, is not a checkout to attach.
    assert.equal((await billing.attachPrecheckout(env, { id: EXISTING, email: 'buyer@example.com' }, { checkoutId: EXISTING }, w.fetcher, NOW)).status, 400);
    assert.equal((await billing.attachPrecheckout(env, { id: EXISTING, email: 'buyer@example.com' }, { checkoutId: 'nope' }, w.fetcher, NOW)).status, 400);
    assert.equal(writer.writes.length, 0, 'nothing ever applied');
  } finally { writer.restore(); }
});

test('existing account: a second claim of the same checkout id never moves or doubles it', async () => {
  const id = freshId();
  const OTHER = '00000000-0000-4000-8000-00000000e3e3';
  const w = existingWorld(id, { users: [[OTHER, { id: OTHER, email: 'other@example.com' }]] });
  const writer = fakeWriter();
  try {
    assert.equal((await billing.attachPrecheckout(env, { id: EXISTING, email: 'buyer@example.com' }, { checkoutId: id }, w.fetcher, NOW)).status, 200);
    // Same account again (a refresh): idempotent, still linked to it.
    const again = await billing.attachPrecheckout(env, { id: EXISTING, email: 'buyer@example.com' }, { checkoutId: id }, w.fetcher, NOW);
    assert.equal(again.status, 200);
    // The buyer later changes the account's email and someone signs up with the paid-with email:
    // the checkout is never re-pointed (the link already exists).
    w.users.set(OTHER, { id: OTHER, email: 'buyer@example.com' });
    w.users.set(EXISTING, { id: EXISTING, email: 'new@example.com' });
    const moved = await billing.attachPrecheckout(env, { id: OTHER, email: 'buyer@example.com' }, { checkoutId: id }, w.fetcher, NOW);
    assert.deepEqual([moved.status, moved.body.error], [409, 'already_claimed']);
    assert.equal(w.links.get(id), EXISTING);
    // The new-account claim of a linked checkout: refused, no account made with id = checkout id.
    const w2 = world({ subs: [sub(id)], links: w.links, paidWith: 'fresh@example.com' });
    const claim = await billing.claimPrecheckout(env, { checkoutId: id, email: 'fresh@example.com' }, w2.fetcher, NOW);
    assert.deepEqual([claim.status, claim.body.error], [409, 'already_claimed']);
    assert.equal(w2.calls.filter((c) => c.method === 'POST' && c.href.endsWith('/auth/v1/admin/users')).length, 0);
    assert.equal(writer.writes.length, 2, 'only the two attaches by the owner applied (replays at the writer)');
    assert.ok(writer.writes.every((x) => x.p_event.app_user_id === id));
  } finally { writer.restore(); }
});

test('existing account: reconcile and the portal also read the linked checkout (renewals, manage card)', async () => {
  const id = freshId();
  const w = existingWorld(id, { world: { links: new Map() } });
  w.links.set(id, EXISTING);
  const writer = fakeWriter();
  try {
    const rc = async (url, init) => {
      if (String(url).includes('api.revenuecat.com') && String(url).includes(`/customers/${EXISTING}/`)) return json({}, 404);
      if (String(url).includes('api.revenuecat.com')) return json({ items: [{ ...sub(id), management_url: 'https://billing.revenuecat.com/portal/x', starts_at: NOW - 60_000 }] });
      return w.fetcher(url, init);
    };
    const r = await billing.reconcileBillingFor(env, EXISTING, rc, NOW);
    assert.deepEqual(r, { reconciled: true, outcomes: ['applied'] });
    assert.equal(writer.writes[0].p_event.app_user_id, id);
    assert.deepEqual(await billing.webCustomerPortalFor(env, EXISTING, rc), { url: 'https://billing.revenuecat.com/portal/x' });
  } finally { writer.restore(); }
});
