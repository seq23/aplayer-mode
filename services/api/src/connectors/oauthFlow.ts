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

export type ConnectorClient = 'app' | 'web';

/**
 * Account-linking phishing (review 2-3 finding 5). The provider callback is a bare browser GET
 * with no APM session, so it never links anything. It parks the encrypted code and hands a
 * one-time secret (the handoff) only to the browser that finished consent: the app's own auth
 * sheet (aplayermode://oauth) or, on web, our page's URL fragment. That client then calls
 * POST /v1/connections/oauth/complete with its own bearer, and the link is made only when the
 * session finishing the flow is the one that started it. A victim sent an attacker's consent
 * link finishes into their own signed-in app, which fails the user check; the attacker never
 * holds the handoff. Every step is single use and the flow dies after 10 minutes.
 */
export async function startConnectorFlow(env: ApiEnv, userId: string, provider: Provider, kind: Kind, access: 'read' | 'act', client: ConnectorClient = 'app') {
  const state = crypto.randomUUID();
  const verifier = randomHex(32);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const codeChallenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const encrypted = await encryptConnectorCredential(env, verifier);

  await supabaseRest(env, SERVICE_ROLE_TOKEN, table, {
    method: 'POST', body: JSON.stringify({
      id: state, user_id: userId, provider, kind, client, verifier_ciphertext: encrypted.ciphertext,
      verifier_iv: encrypted.iv, expires_at: new Date(Date.now() + 600_000).toISOString(),
    }),
  });
  return { state, authorizationUrl: buildOAuthAuthorizationUrl({ env, provider, kind, codeChallenge, state, access }) };
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');

function handoffRedirect(env: ApiEnv, client: ConnectorClient, params: Record<string, string>) {
  if (client === 'app') return finish(params);
  // Web: a fragment never reaches a server log or a Referer header.
  const base = (env.APP_PUBLIC_URL ?? '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) return finish({ error: 'connector_oauth_failed' });
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/oauth/complete#${new URLSearchParams(params)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

/** The provider's redirect: parks the code for the session that started the flow. Links nothing. */
export async function connectorCallback(env: ApiEnv, provider: Provider, url: URL) {
  const stop = connectorConfigStop(env, provider);
  if (stop) return finish({ error: stop });
  const state = z.uuid().safeParse(url.searchParams.get('state'));
  if (!state.success || url.searchParams.getAll('state').length !== 1) return finish({ error: 'invalid_oauth_state' });
  try {
    // Single use: only a live flow whose code was never parked can be claimed, once.
    const path = `${table}?id=eq.${state.data}&provider=eq.${provider}&${expiry()}&verifier_ciphertext=not.is.null&handoff_hash=is.null&error_code=is.null`;
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) {
      const claimed = await supabaseRest<Array<{ client: ConnectorClient }>>(env, SERVICE_ROLE_TOKEN, `${path}&select=client`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ verifier_ciphertext: null, verifier_iv: null, error_code: 'oauth_cancelled' }),
      });
      return claimed.length ? handoffRedirect(env, claimed[0]!.client, { error: 'oauth_cancelled' }) : finish({ error: 'invalid_oauth_state' });
    }
    const handoff = randomHex(32);
    const sealed = await encryptConnectorCredential(env, code);
    const claimed = await supabaseRest<Array<{ client: ConnectorClient }>>(env, SERVICE_ROLE_TOKEN, `${path}&select=client`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ code_ciphertext: sealed.ciphertext, code_iv: sealed.iv, handoff_hash: await sha256Hex(handoff) }),
    });
    if (!claimed.length) return finish({ error: 'invalid_oauth_state' });
    return handoffRedirect(env, claimed[0]!.client, { state: state.data, handoff });
  } catch {
    console.warn('NAMED STOP [CONNECTOR_OAUTH_CALLBACK_FAILED]', { provider });
    return finish({ error: 'connector_oauth_failed' });
  }
}

export type ConnectorCompletion =
  | { ok: true; connectionId: string; provider: Provider; kind: Kind }
  | { ok: false; status: 400 | 403 | 409 | 502 | 503; error: string };

type ParkedFlow = { user_id: string; provider: Provider; kind: Kind; verifier_ciphertext: string; verifier_iv: string; code_ciphertext: string; code_iv: string };

/** The signed-in client that finished consent presents the handoff; the link is made only for the user who started the flow. */
export async function completeConnectorFlow(env: ApiEnv, userId: string, input: { state: string; handoff: string }): Promise<ConnectorCompletion> {
  const state = z.uuid().safeParse(input.state);
  if (!state.success || !/^[0-9a-f]{64}$/.test(input.handoff)) return { ok: false, status: 400, error: 'invalid_request' };
  const path = `${table}?id=eq.${state.data}&handoff_hash=eq.${await sha256Hex(input.handoff)}&${expiry()}&code_ciphertext=not.is.null&verifier_ciphertext=not.is.null`;
  const [flow] = await supabaseRest<ParkedFlow[]>(env, SERVICE_ROLE_TOKEN, `${path}&select=user_id,provider,kind,verifier_ciphertext,verifier_iv,code_ciphertext,code_iv`);
  if (!flow) return { ok: false, status: 409, error: 'oauth_flow_expired' };
  // Burn the code before anything else: one try, whoever presents it.
  const claimed = await supabaseRest<Array<{ id: string }>>(env, SERVICE_ROLE_TOKEN, `${path}&select=id`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ code_ciphertext: null, code_iv: null, verifier_ciphertext: null, verifier_iv: null }),
  });
  if (!claimed.length) return { ok: false, status: 409, error: 'oauth_flow_expired' };
  if (flow.user_id !== userId) {
    await recordFlowError(env, state.data, flow.provider, 'oauth_session_mismatch').catch(() => undefined);
    console.warn('NAMED STOP [CONNECTOR_OAUTH_SESSION_MISMATCH]', { provider: flow.provider });
    return { ok: false, status: 403, error: 'oauth_session_mismatch' };
  }
  try {
    const [code, codeVerifier] = await Promise.all([
      decryptConnectorCredential<string>(env, flow.code_ciphertext, flow.code_iv),
      decryptConnectorCredential<string>(env, flow.verifier_ciphertext, flow.verifier_iv),
    ]);
    const { connectionId } = await exchangeAndStoreOAuthConnection({
      env, accessToken: SERVICE_ROLE_TOKEN, userId, provider: flow.provider, kind: flow.kind, code, codeVerifier,
    });
    await supabaseRest(env, SERVICE_ROLE_TOKEN, `${table}?id=eq.${state.data}`, { method: 'PATCH', body: JSON.stringify({ connection_id: connectionId }) });
    return { ok: true, connectionId, provider: flow.provider, kind: flow.kind };
  } catch (error) {
    // Nothing was stored: the connection row is written only after the exchange and identity
    // read both succeed, and an existing link is never touched on this path.
    const outage = providerOutage(error);
    const code = outage ? 'connector_provider_unavailable' : 'connector_oauth_failed';
    await recordFlowError(env, state.data, flow.provider, code).catch(() => undefined);
    console.warn(`NAMED STOP [${outage ? 'CONNECTOR_PROVIDER_UNAVAILABLE' : 'CONNECTOR_OAUTH_EXCHANGE_FAILED'}]`, { provider: flow.provider });
    return outage ? { ok: false, status: 503, error: code } : { ok: false, status: 502, error: code };
  }
}

/** A provider that is down (5xx, 429 or no answer), as opposed to a refused code. */
function providerOutage(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const match = /_(?:token_exchange|identity)_failed:(\d{3})$/.exec(error instanceof Error ? error.message : '');
  return Boolean(match && (Number(match[1]) >= 500 || match[1] === '429'));
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
