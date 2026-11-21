// Calendar and mail account linking (review 2-3 finding 5, account-linking phishing). The
// provider callback carries no APM session, so it links nothing: it parks the code and hands a
// one-time secret to the client that finished consent. POST /v1/connections/oauth/complete links
// the account only for the signed-in user who started the flow. Each test here fails on the
// pre-fix callback, which linked the account to whoever started the flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const result = await build({
  stdin: { contents: "export * from './src/connectors/oauthFlow'; export { decryptConnectorCredential } from './src/crypto';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const { connectorCallback, connectorConfigStop, connectorFlowResult, startConnectorFlow, completeConnectorFlow, decryptConnectorCredential } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const outDir = await mkdtemp(join(tmpdir(), 'apm-oauth-flow-'));
await build({ entryPoints: { index: join(srcDir, 'index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent', define: { __APM_BUILD_SHA__: "'test'", __APM_RUNTIME_ENVIRONMENT__: "'production'" } });
const app = (await import(pathToFileURL(join(outDir, 'index.js')).href)).default;
test.after(() => rm(outDir, { recursive: true, force: true }));

const env = {
  SUPABASE_URL: 'https://flow.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-service',
  CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'), APP_PUBLIC_URL: 'https://app.aplayermode.com',
  GOOGLE_OAUTH_CLIENT_ID: 'google-fixture', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://api.aplayermode.com/v1/oauth/google/callback',
  MICROSOFT_OAUTH_CLIENT_ID: 'microsoft-fixture', MICROSOFT_OAUTH_CLIENT_SECRET: 'fixture-secret',
  MICROSOFT_OAUTH_REDIRECT_URI: 'https://api.aplayermode.com/v1/oauth/microsoft/callback',
};
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const EXISTING = '00000000-0000-4000-8000-0000000000e1';
const NEW_LINK = '00000000-0000-4000-8000-0000000000e2';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const callbackUrl = (provider, state, extra = 'code=provider-code') => new URL(`${env[provider.toUpperCase() + '_OAUTH_REDIRECT_URI']}?state=${state}&${extra}`);

/** PostgREST filters the flow code uses (eq, is.null, not.is.null, gt), applied to every column. */
function matches(row, params) {
  for (const [key, raw] of params) {
    if (['select', 'on_conflict'].includes(key)) continue;
    const value = row[key] ?? null;
    if (raw === 'is.null') { if (value !== null) return false; }
    else if (raw === 'not.is.null') { if (value === null) return false; }
    else if (raw.startsWith('eq.')) { if (String(value) !== raw.slice(3)) return false; }
    else if (raw.startsWith('gt.')) { if (!(value > raw.slice(3))) return false; }
    else if (raw.startsWith('lte.')) { if (!(value <= raw.slice(3))) return false; }
    else throw new Error(`unhandled filter ${key}=${raw}`);
  }
  return true;
}

/**
 * A fake Supabase + provider. `sessions` maps bearer tokens to user ids. The connections table
 * starts with one existing calendar link for A, so every test can prove it is never removed.
 */
function fakeBackend(t, { token = () => json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3600 }) } = {}) {
  const db = { flows: [], connections: [{ id: EXISTING, user_id: A, provider: 'google', kind: 'calendar', external_account_id: 'a-old@example.com', status: 'connected', encrypted_credentials: 'sealed-old' }] };
  const calls = { exchanges: 0, connectionWrites: [], challenge: null };
  const sessions = { 'jwt-a': A, 'jwt-b': B };
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (raw, request = {}) => {
    const url = new URL(raw);
    const method = request.method ?? 'GET';
    if (url.origin === env.SUPABASE_URL) {
      if (url.pathname === '/auth/v1/user') {
        const id = sessions[new Headers(request.headers).get('authorization')?.replace('Bearer ', '')];
        return id ? json({ id }) : json({ error: 'bad jwt' }, 401);
      }
      if (url.pathname === '/rest/v1/rpc/apm_my_consents') return json({ ageConfirmedAt: '2026-01-01T00:00:00Z' });
      if (url.pathname.startsWith('/rest/v1/rpc/')) return json(null);
      assert.equal(new Headers(request.headers).get('apikey'), env.SUPABASE_SECRET_KEY, 'flow rows are server-only');
      if (url.pathname === '/rest/v1/connector_oauth_flows') {
        const hit = db.flows.filter((row) => matches(row, url.searchParams));
        if (method === 'POST') { db.flows.push({ handoff_hash: null, code_ciphertext: null, code_iv: null, error_code: null, connection_id: null, client: 'app', ...JSON.parse(request.body) }); return new Response(null, { status: 201 }); }
        if (method === 'DELETE') { db.flows = db.flows.filter((row) => !hit.includes(row)); return new Response(null, { status: 204 }); }
        if (method === 'PATCH') for (const row of hit) Object.assign(row, JSON.parse(request.body));
        return json(hit.map((row) => ({ ...row })));
      }
      if (url.pathname === '/rest/v1/integration_connections') {
        calls.connectionWrites.push(method);
        if (method === 'POST') { const row = JSON.parse(request.body)[0]; db.connections.push({ id: NEW_LINK, ...row }); return json([{ id: NEW_LINK }]); }
        throw new Error(`the connect flow never ${method}s an existing link`);
      }
      if (url.pathname === '/rest/v1/audit_events' || url.pathname.startsWith('/rest/v1/rpc')) return json([]);
      throw new Error(`Unexpected Supabase call: ${method} ${url.pathname}`);
    }
    if (url.pathname.endsWith('/token')) {
      calls.exchanges += 1;
      assert.equal(request.body.get('code'), 'provider-code');
      assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), calls.challenge, 'PKCE verifier matches the challenge');
      return token();
    }
    if (url.hostname === 'openidconnect.googleapis.com') return json({ sub: 'provider-user', email: 'b@example.com' });
    if (url.hostname === 'graph.microsoft.com') return json({ id: 'provider-user', mail: 'b@example.com' });
    throw new Error(`Unexpected network call: ${url.origin}${url.pathname}`);
  });
  return { db, calls };
}

async function startAndConsent(backend, provider, userId, client = 'app') {
  const start = await startConnectorFlow(env, userId, provider, 'calendar', 'read', client);
  backend.calls.challenge = new URL(start.authorizationUrl).searchParams.get('code_challenge');
  const response = await connectorCallback(env, provider, callbackUrl(provider, start.state));
  const location = new URL(response.headers.get('location'));
  const params = client === 'web' ? new URLSearchParams(location.hash.slice(1)) : location.searchParams;
  return { start, response, location, state: params.get('state'), handoff: params.get('handoff') };
}

const complete = (token, body) => app.fetch(new Request('https://api.aplayermode.com/v1/connections/oauth/complete', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}), env);
const existingLinkUntouched = (db) => assert.deepEqual(db.connections.find((row) => row.id === EXISTING),
  { id: EXISTING, user_id: A, provider: 'google', kind: 'calendar', external_account_id: 'a-old@example.com', status: 'connected', encrypted_credentials: 'sealed-old' });

for (const provider of ['google', 'microsoft']) {
  test(`${provider}: a normal connect links the account only when the session that started it finishes it`, async (t) => {
    const backend = fakeBackend(t);
    const flow = await startAndConsent(backend, provider, A);
    assert.equal(new URL(flow.start.authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.location.protocol + '//' + flow.location.hostname, 'aplayermode://oauth');
    assert.equal(flow.state, flow.start.state);
    assert.match(flow.handoff, /^[0-9a-f]{64}$/);
    assert.equal(backend.calls.exchanges, 0, 'the bare callback exchanges and links nothing');
    assert.equal(backend.db.connections.length, 1);
    assert.doesNotMatch(JSON.stringify(backend.db.flows), new RegExp(`provider-code|${flow.handoff}`), 'only the sealed code and the handoff hash are stored');

    const done = await complete('jwt-a', { state: flow.state, handoff: flow.handoff });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { connectionId: NEW_LINK });
    assert.equal(backend.calls.exchanges, 1);
    const linked = backend.db.connections.find((row) => row.id === NEW_LINK);
    assert.equal(linked.user_id, A);
    assert.equal((await decryptConnectorCredential(env, linked.encrypted_credentials, linked.credential_iv)).refreshToken, 'fixture-refresh-token');
    assert.deepEqual(await connectorFlowResult(env, A, flow.state), { connectionId: NEW_LINK, error: null });
    assert.deepEqual(await connectorFlowResult(env, B, flow.state), { connectionId: null, error: null }, 'another user cannot read the result');
    existingLinkUntouched(backend.db);
  });
}

test('abuse: a flow user A started is refused when user B\'s session finishes it, and nothing is linked to either', async (t) => {
  const backend = fakeBackend(t);
  // The attacker (A) starts the flow and sends the consent link to the victim (B), whose app finishes it.
  const flow = await startAndConsent(backend, 'google', A);
  const refused = await complete('jwt-b', { state: flow.state, handoff: flow.handoff });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'oauth_session_mismatch');
  assert.equal(backend.calls.exchanges, 0, 'the victim\'s code is never exchanged');
  assert.deepEqual(backend.calls.connectionWrites, []);
  // The attacker cannot finish it afterwards either: the code was burned on the first try.
  const after = await complete('jwt-a', { state: flow.state, handoff: flow.handoff });
  assert.equal(after.status, 409);
  assert.equal(backend.calls.exchanges, 0);
  existingLinkUntouched(backend.db);
});

test('abuse: a lying client posting a state or handoff it was never given is refused', async (t) => {
  const backend = fakeBackend(t);
  const flow = await startAndConsent(backend, 'microsoft', A);
  const guessed = await complete('jwt-a', { state: flow.state, handoff: 'f'.repeat(64) });
  assert.equal(guessed.status, 409);
  const otherState = await complete('jwt-a', { state: crypto.randomUUID(), handoff: flow.handoff });
  assert.equal(otherState.status, 409);
  const junk = await complete('jwt-a', { state: 'not-a-uuid', handoff: flow.handoff, userId: B });
  assert.equal(junk.status, 400);
  // A client that posts its own idea of the user is ignored; the session decides.
  const withUser = await complete('jwt-b', { state: flow.state, handoff: flow.handoff, userId: A });
  assert.equal(withUser.status, 403);
  assert.equal(backend.calls.exchanges, 0);
  assert.deepEqual(backend.calls.connectionWrites, []);
});

test('replay: a consumed callback state and a used handoff are both refused', async (t) => {
  const backend = fakeBackend(t);
  const flow = await startAndConsent(backend, 'google', A);
  const replayedCallback = await connectorCallback(env, 'google', callbackUrl('google', flow.state));
  assert.equal(replayedCallback.headers.get('location'), 'aplayermode://oauth?error=invalid_oauth_state');
  const [first, second] = await Promise.all([
    complete('jwt-a', { state: flow.state, handoff: flow.handoff }),
    complete('jwt-a', { state: flow.state, handoff: flow.handoff }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const third = await complete('jwt-a', { state: flow.state, handoff: flow.handoff });
  assert.equal(third.status, 409);
  assert.equal(backend.calls.exchanges, 1);
});

test('expiry: a flow older than 10 minutes is refused at the callback and at completion', async (t) => {
  const backend = fakeBackend(t);
  const late = await startConnectorFlow(env, A, 'google', 'calendar', 'read');
  backend.db.flows.find((row) => row.id === late.state).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await connectorCallback(env, 'google', callbackUrl('google', late.state))).headers.get('location'), 'aplayermode://oauth?error=invalid_oauth_state');

  const flow = await startAndConsent(backend, 'google', A);
  backend.db.flows.find((row) => row.id === flow.state).expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await complete('jwt-a', { state: flow.state, handoff: flow.handoff });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, 'oauth_flow_expired');
  assert.equal(backend.calls.exchanges, 0);
});

test('a missing or invalid session is refused before the flow is read', async (t) => {
  const backend = fakeBackend(t);
  const flow = await startAndConsent(backend, 'microsoft', A);
  const before = JSON.stringify(backend.db.flows);
  assert.equal((await complete(null, { state: flow.state, handoff: flow.handoff })).status, 401);
  assert.equal((await complete('jwt-forged', { state: flow.state, handoff: flow.handoff })).status, 401);
  assert.equal(JSON.stringify(backend.db.flows), before, 'the flow is still usable by its owner');
  assert.equal((await complete('jwt-a', { state: flow.state, handoff: flow.handoff })).status, 200);
});

test('web: the handoff goes in the web app\'s URL fragment, never a query a server logs', async (t) => {
  const backend = fakeBackend(t);
  const flow = await startAndConsent(backend, 'google', A, 'web');
  assert.equal(flow.location.origin + flow.location.pathname, 'https://app.aplayermode.com/oauth/complete');
  assert.equal(flow.location.search, '');
  assert.equal(flow.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await complete('jwt-a', { state: flow.state, handoff: flow.handoff })).status, 200);
});

test('data loss: a cancelled, refused or failed connect never removes or changes the existing calendar link', async (t) => {
  const backend = fakeBackend(t, { token: () => json({ error: 'invalid_grant' }, 400) });
  const cancelled = await startConnectorFlow(env, A, 'google', 'calendar', 'read');
  const denied = await connectorCallback(env, 'google', callbackUrl('google', cancelled.state, 'error=access_denied'));
  assert.equal(denied.headers.get('location'), 'aplayermode://oauth?error=oauth_cancelled');
  const mismatch = await startAndConsent(backend, 'google', A);
  assert.equal((await complete('jwt-b', { state: mismatch.state, handoff: mismatch.handoff })).status, 403);
  const failed = await startAndConsent(backend, 'google', A);
  const refusedCode = await complete('jwt-a', { state: failed.state, handoff: failed.handoff });
  assert.equal(refusedCode.status, 502);
  assert.equal((await refusedCode.json()).error, 'connector_oauth_failed');
  assert.deepEqual(backend.calls.connectionWrites, [], 'no write of any kind reached integration_connections');
  existingLinkUntouched(backend.db);
  assert.deepEqual(await connectorFlowResult(env, A, failed.state), { connectionId: null, error: 'connector_oauth_failed' });
});

test('outage: the provider token endpoint 5xx gives a plain try-again answer and stores no half-done link', async (t) => {
  const backend = fakeBackend(t, { token: () => new Response('upstream down', { status: 503 }) });
  const flow = await startAndConsent(backend, 'microsoft', A);
  const down = await complete('jwt-a', { state: flow.state, handoff: flow.handoff });
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: 'connector_provider_unavailable' });
  assert.deepEqual(backend.calls.connectionWrites, [], 'no connection row is written');
  assert.equal(backend.db.connections.length, 1);
  existingLinkUntouched(backend.db);
  const row = backend.db.flows.find((item) => item.id === flow.state);
  assert.equal(row.connection_id, null);
  assert.equal(row.code_ciphertext, null, 'the parked code is not left behind');
  assert.deepEqual(await connectorFlowResult(env, A, flow.state), { connectionId: null, error: 'connector_provider_unavailable' });
});

test('missing client secret stops before networking and never leaks provider error details', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No provider calls with missing client secret'));
  const missing = { ...env, GOOGLE_OAUTH_CLIENT_SECRET: undefined };
  assert.equal(connectorConfigStop(missing, 'google'), 'google_oauth_client_secret_missing');
  const response = await connectorCallback(missing, 'google', callbackUrl('google', crypto.randomUUID()));
  assert.equal(response.headers.get('location'), 'aplayermode://oauth?error=google_oauth_client_secret_missing');
  assert.equal(await response.text(), '');
});

test('completeConnectorFlow checks the user it is given against the flow owner', async (t) => {
  const backend = fakeBackend(t);
  const flow = await startAndConsent(backend, 'google', A);
  assert.deepEqual(await completeConnectorFlow(env, B, { state: flow.state, handoff: flow.handoff }), { ok: false, status: 403, error: 'oauth_session_mismatch' });
});
