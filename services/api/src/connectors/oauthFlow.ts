import { z } from 'zod';
import type { ApiEnv } from '../env';
import { decryptConnectorCredential, encryptConnectorCredential } from '../crypto';
import { SERVICE_ROLE_TOKEN, supabaseRest } from '../db';
import { buildOAuthAuthorizationUrl, exchangeAndStoreOAuthConnection } from './oauth';

type Provider = 'google' | 'microsoft';
type Kind = 'email' | 'calendar';
const table = '/rest/v1/connector_oauth_flows';
const clock = () => encodeURIComponent(new Date().toISOString());
const expiry = () => `expires_at=gt.${clock()}`;
const finish = (params: Record<string, string>) => new Response(null, {
  status: 302,
  headers: { location: `aplayermode://oauth?${new URLSearchParams(params)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
});

export function connectorConfigStop(env: ApiEnv, provider: Provider): string | undefined {
  const google = provider === 'google';
  const id = google ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_OAUTH_CLIENT_ID;
  const secret = google ? env.GOOGLE_OAUTH_CLIENT_SECRET : env.MICROSOFT_OAUTH_CLIENT_SECRET;
  const redirect = google ? env.GOOGLE_OAUTH_REDIRECT_URI : env.MICROSOFT_OAUTH_REDIRECT_URI;
  if (!env.CONNECTOR_CREDENTIAL_KEY || !env.SUPABASE_SECRET_KEY) return 'connector_oauth_storage_not_configured';
  if (!id) return `${provider}_connector_not_configured`;
  if (!secret) return `${provider}_oauth_client_secret_missing`;
  try {
    const url = new URL(redirect ?? '');
    if (url.protocol === 'https:' && url.pathname === `/v1/oauth/${provider}/callback`
      && !url.username && !url.password && !url.search && !url.hash) return;
  } catch { /* Configuration error below. */ }
  return `${provider}_oauth_redirect_invalid`;
}

export function expireConnectorFlows(env: ApiEnv) {
  return supabaseRest(env, SERVICE_ROLE_TOKEN, `${table}?expires_at=lte.${clock()}`, { method: 'DELETE' });
}

export async function startConnectorFlow(env: ApiEnv, userId: string, provider: Provider, kind: Kind, access: 'read' | 'act') {
  const state = crypto.randomUUID();
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const codeChallenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const encrypted = await encryptConnectorCredential(env, verifier);

  await supabaseRest(env, SERVICE_ROLE_TOKEN, table, {
    method: 'POST', body: JSON.stringify({
      id: state, user_id: userId, provider, kind, verifier_ciphertext: encrypted.ciphertext,
      verifier_iv: encrypted.iv, expires_at: new Date(Date.now() + 600_000).toISOString(),
    }),
  });
  return { state, authorizationUrl: buildOAuthAuthorizationUrl({ env, provider, kind, codeChallenge, state, access }) };
}

export async function connectorCallback(env: ApiEnv, provider: Provider, url: URL, onConnected: (userId: string, kind: Kind, id: string) => Promise<void>) {
  const stop = connectorConfigStop(env, provider);
  if (stop) return finish({ error: stop });
  const state = z.uuid().safeParse(url.searchParams.get('state'));
  if (!state.success || url.searchParams.getAll('state').length !== 1) return finish({ error: 'invalid_oauth_state' });
  let consumed = false;
  try {
    const path = `${table}?id=eq.${state.data}&provider=eq.${provider}&${expiry()}`;
    const [flow] = await supabaseRest<Array<{ user_id: string; kind: Kind; verifier_ciphertext: string; verifier_iv: string }>>(
      env, SERVICE_ROLE_TOKEN, `${path}&verifier_ciphertext=not.is.null&select=user_id,kind,verifier_ciphertext,verifier_iv`,
    );
    if (!flow) return finish({ error: 'invalid_oauth_state' });
    // Claim exactly once before attempting the exchange, including provider denial.
    const claimed = await supabaseRest<Array<{ id: string }>>(env, SERVICE_ROLE_TOKEN, `${path}&verifier_ciphertext=not.is.null&select=id`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ verifier_ciphertext: null, verifier_iv: null }),
    });
    if (!claimed.length) return finish({ error: 'invalid_oauth_state' });
    consumed = true;
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) {
      await recordFlowError(env, state.data, provider, 'oauth_cancelled');
      return finish({ error: 'oauth_cancelled' });
    }
    const codeVerifier = await decryptConnectorCredential<string>(env, flow.verifier_ciphertext, flow.verifier_iv);
    const { connectionId } = await exchangeAndStoreOAuthConnection({
      env, accessToken: SERVICE_ROLE_TOKEN, userId: flow.user_id, provider, kind: flow.kind, code, codeVerifier,
    });
    await supabaseRest(env, SERVICE_ROLE_TOKEN, path, { method: 'PATCH', body: JSON.stringify({ connection_id: connectionId }) });
    await onConnected(flow.user_id, flow.kind, connectionId);
    return finish({ connected: provider });
  } catch {
    if (consumed) await recordFlowError(env, state.data, provider, 'connector_oauth_failed').catch(() => undefined);
    console.warn('NAMED STOP [CONNECTOR_OAUTH_CALLBACK_FAILED]', { provider });
    return finish({ error: 'connector_oauth_failed' });
  }
}

function recordFlowError(env: ApiEnv, state: string, provider: Provider, error: string) {
  return supabaseRest(env, SERVICE_ROLE_TOKEN, `${table}?id=eq.${state}&provider=eq.${provider}&connection_id=is.null`, {
    method: 'PATCH', body: JSON.stringify({ error_code: error }),
  });
}

export async function connectorFlowResult(env: ApiEnv, userId: string, state: string) {
  const rows = await supabaseRest<Array<{ connection_id: string | null; error_code: string | null }>>(env, SERVICE_ROLE_TOKEN,
    `${table}?id=eq.${state}&user_id=eq.${encodeURIComponent(userId)}&${expiry()}&select=connection_id,error_code`);
  return { connectionId: rows[0]?.connection_id ?? null, error: rows[0]?.error_code ?? null };
}
