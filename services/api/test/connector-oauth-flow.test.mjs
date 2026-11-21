import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const result = await build({
  stdin: {
    contents: "export * from './src/connectors/oauthFlow'; export { decryptConnectorCredential } from './src/crypto';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const { connectorCallback, connectorConfigStop, connectorFlowResult, startConnectorFlow, decryptConnectorCredential } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const env = {
  SUPABASE_URL: 'https://flow.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-service',
  CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_OAUTH_CLIENT_ID: 'google-fixture', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://api.aplayermode.com/v1/oauth/google/callback',
  MICROSOFT_OAUTH_CLIENT_ID: 'microsoft-fixture', MICROSOFT_OAUTH_CLIENT_SECRET: 'fixture-secret',
  MICROSOFT_OAUTH_REDIRECT_URI: 'https://api.aplayermode.com/v1/oauth/microsoft/callback',
};
const user = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const json = (data) => new Response(JSON.stringify(data));
const callback = (provider, state) => new URL(`${env[provider.toUpperCase() + '_OAUTH_REDIRECT_URI']}?state=${state}&code=provider-code`);

for (const provider of ['google', 'microsoft']) {
  test(`${provider} exchanges server-side using PKCE, stores encrypted tokens and refuses forged and replayed state`, async (t) => {
    let flow, connection, challenge, exchanges = 0;
    const output = [];
    t.mock.method(console, 'warn', (...args) => output.push(args));
    t.mock.method(console, 'error', (...args) => output.push(args));
    t.mock.method(globalThis, 'fetch', async (raw, request = {}) => {
      const url = new URL(raw);
      const method = request.method ?? 'GET';
      if (url.origin === env.SUPABASE_URL) {
        assert.equal(new Headers(request.headers).get('apikey'), env.SUPABASE_SECRET_KEY);
        if (url.pathname.endsWith('/connector_oauth_flows')) {
          if (method === 'DELETE') return new Response(null, { status: 204 });
          if (method === 'POST') {
            flow = JSON.parse(request.body);
            return new Response(null, { status: 201 });
          }
          if (!flow || url.searchParams.get('id') !== `eq.${flow.id}`) return json([]);
          if (url.searchParams.has('provider') && url.searchParams.get('provider') !== `eq.${flow.provider}`) return json([]);
          if (url.searchParams.has('user_id') && url.searchParams.get('user_id') !== `eq.${flow.user_id}`) return json([]);
          if (url.searchParams.has('verifier_ciphertext') && !flow.verifier_ciphertext) return json([]);
          if (method === 'PATCH') Object.assign(flow, JSON.parse(request.body));
          return json([flow]);
        }
        if (url.pathname.endsWith('/integration_connections')) {
          connection = JSON.parse(request.body)[0];
          return json([{ id }]);
        }
      }
      if (url.pathname.endsWith('/token')) {
        exchanges += 1;
        assert.equal(request.body.get('client_secret'), 'fixture-secret');
        assert.equal(request.body.get('code'), 'provider-code');
        assert.equal(request.body.get('redirect_uri'), env[provider.toUpperCase() + '_OAUTH_REDIRECT_URI']);
        assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), challenge);
        return json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3600 });
      }
      if (url.hostname === 'openidconnect.googleapis.com') return json({ sub: 'provider-user' });
      if (url.hostname === 'graph.microsoft.com') return json({ id: 'provider-user' });
      throw new Error(`Unexpected network call: ${url.origin}`);
    });
    const start = await startConnectorFlow(env, user, provider, 'calendar', 'act');
    const authorize = new URL(start.authorizationUrl);
    assert.equal(authorize.searchParams.get('state'), start.state);
    assert.equal(authorize.searchParams.get('redirect_uri'), env[provider.toUpperCase() + '_OAUTH_REDIRECT_URI']);
    challenge = authorize.searchParams.get('code_challenge');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.doesNotMatch(start.authorizationUrl, /code_verifier|fixture-secret/);
    const onConnected = async (owner, kind, connectedId) => assert.deepEqual([owner, kind, connectedId], [user, 'calendar', id]);
    const forged = await connectorCallback(env, provider, callback(provider, crypto.randomUUID()), onConnected);
    assert.match(forged.headers.get('location'), /invalid_oauth_state/);
    assert.equal(exchanges, 0);
    const [first, replay] = await Promise.all([
      connectorCallback(env, provider, callback(provider, start.state), onConnected),
      connectorCallback(env, provider, callback(provider, start.state), onConnected),
    ]);
    const locations = [first, replay].map((response) => response.headers.get('location')).sort();
    assert.deepEqual(locations, [`aplayermode://oauth?connected=${provider}`, 'aplayermode://oauth?error=invalid_oauth_state']);
    assert.equal(exchanges, 1);
    assert.equal(await first.text(), '');
    assert.doesNotMatch(JSON.stringify([locations, output, connection]), /fixture-access-token|fixture-refresh-token|provider-code/);
    const stored = await decryptConnectorCredential(env, connection.encrypted_credentials, connection.credential_iv);
    assert.equal(stored.refreshToken, 'fixture-refresh-token');
    assert.equal(connection.user_id, user);
    assert.deepEqual(await connectorFlowResult(env, user, start.state), { connectionId: id, error: null });
    assert.deepEqual(await connectorFlowResult(env, id, start.state), { connectionId: null, error: null });
  });
}

test('missing client secret stops before networking and never leaks provider error details', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No provider calls with missing client secret'));
  const missing = { ...env, GOOGLE_OAUTH_CLIENT_SECRET: undefined };
  assert.equal(connectorConfigStop(missing, 'google'), 'google_oauth_client_secret_missing');
  const response = await connectorCallback(missing, 'google', callback('google', crypto.randomUUID()), () => assert.fail('No connection'));
  assert.equal(response.headers.get('location'), 'aplayermode://oauth?error=google_oauth_client_secret_missing');
  assert.equal(await response.text(), '');
});
