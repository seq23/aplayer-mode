import type { IntegrationKind, IntegrationProvider } from '@apm/domain';
import type { ApiEnv } from '../env';
import { decryptConnectorCredential, encryptConnectorCredential } from '../crypto';
import { supabaseRest } from '../db';

export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

interface ConnectionSecretRow {
  id: string;
  provider: IntegrationProvider;
  kind: IntegrationKind;
  encrypted_credentials: string | null;
  credential_iv: string | null;
}

export function oauthScopes(provider: 'google' | 'microsoft', kind: IntegrationKind): string[] {
  if (provider === 'google') {
    return kind === 'calendar'
      ? ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly']
      : ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
  }
  return kind === 'calendar'
    ? ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.Read']
    : ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read'];
}

export function buildOAuthAuthorizationUrl(input: {
  env: ApiEnv;
  provider: 'google' | 'microsoft';
  kind: IntegrationKind;
  codeChallenge: string;
  state: string;
  redirectUri?: string;
}): string {
  const scopes = oauthScopes(input.provider, input.kind);
  if (input.provider === 'google') {
    if (!input.env.GOOGLE_OAUTH_CLIENT_ID) throw new Error('Google OAuth is not configured');
    const redirectUri = input.redirectUri ?? input.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!redirectUri) throw new Error('Google OAuth redirect URI is not configured');
    const params = new URLSearchParams({
      client_id: input.env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  if (!input.env.MICROSOFT_OAUTH_CLIENT_ID) throw new Error('Microsoft OAuth is not configured');
  const redirectUri = input.redirectUri ?? input.env.MICROSOFT_OAUTH_REDIRECT_URI;
  if (!redirectUri) throw new Error('Microsoft OAuth redirect URI is not configured');
  const tenant = input.env.MICROSOFT_TENANT ?? 'common';
  const params = new URLSearchParams({
    client_id: input.env.MICROSOFT_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeGoogle(env: ApiEnv, code: string, codeVerifier: string, redirectUri?: string): Promise<ConnectorTokens> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('Google OAuth is not configured');
  const resolvedRedirect = redirectUri ?? env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!resolvedRedirect) throw new Error('Google OAuth redirect URI is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: resolvedRedirect,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error(`google_token_exchange_failed:${response.status}`);
  const data = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined, tokenType: data.token_type, scope: data.scope };
}

async function exchangeMicrosoft(env: ApiEnv, code: string, codeVerifier: string, redirectUri?: string): Promise<ConnectorTokens> {
  if (!env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error('Microsoft OAuth is not configured');
  const resolvedRedirect = redirectUri ?? env.MICROSOFT_OAUTH_REDIRECT_URI;
  if (!resolvedRedirect) throw new Error('Microsoft OAuth redirect URI is not configured');
  const tenant = env.MICROSOFT_TENANT ?? 'common';
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
      redirect_uri: resolvedRedirect,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error(`microsoft_token_exchange_failed:${response.status}`);
  const data = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined, tokenType: data.token_type, scope: data.scope };
}

async function externalIdentity(provider: 'google' | 'microsoft', token: string): Promise<{ id: string; label?: string }> {
  const url = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${provider}_identity_failed:${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  if (provider === 'google') return { id: String(data.sub ?? ''), label: typeof data.email === 'string' ? data.email : undefined };
  return { id: String(data.id ?? ''), label: typeof data.mail === 'string' ? data.mail : typeof data.userPrincipalName === 'string' ? data.userPrincipalName : typeof data.displayName === 'string' ? data.displayName : undefined };
}

export async function exchangeAndStoreOAuthConnection(input: {
  env: ApiEnv;
  accessToken: string;
  userId: string;
  provider: 'google' | 'microsoft';
  kind: IntegrationKind;
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}): Promise<{ connectionId: string; accountLabel?: string }> {
  const tokens = input.provider === 'google'
    ? await exchangeGoogle(input.env, input.code, input.codeVerifier, input.redirectUri)
    : await exchangeMicrosoft(input.env, input.code, input.codeVerifier, input.redirectUri);
  const identity = await externalIdentity(input.provider, tokens.accessToken);
  if (!identity.id) throw new Error('connector_identity_missing');
  const encrypted = await encryptConnectorCredential(input.env, tokens);
  const scopes = tokens.scope?.split(' ').filter(Boolean) ?? oauthScopes(input.provider, input.kind);
  const rows = await supabaseRest<Array<{ id: string }>>(input.env, input.accessToken, '/rest/v1/integration_connections?on_conflict=user_id,provider,kind,external_account_id&select=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      user_id: input.userId,
      provider: input.provider,
      kind: input.kind,
      account_label: identity.label ?? null,
      external_account_id: identity.id,
      status: 'connected',
      scopes,
      encrypted_credentials: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      credential_version: 1,
      updated_at: new Date().toISOString(),
    }]),
  });
  const connectionId = rows[0]?.id;
  if (!connectionId) throw new Error('connection_write_failed');
  return { connectionId, accountLabel: identity.label };
}

async function loadConnectionSecret(env: ApiEnv, accessToken: string, userId: string, connectionId: string): Promise<ConnectionSecretRow> {
  const rows = await supabaseRest<ConnectionSecretRow[]>(env, accessToken, `/rest/v1/integration_connections?id=eq.${encodeURIComponent(connectionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,provider,kind,encrypted_credentials,credential_iv&limit=1`);
  const row = rows[0];
  if (!row?.encrypted_credentials || !row.credential_iv) throw new Error('connection_credentials_missing');
  return row;
}

async function refreshGoogle(env: ApiEnv, token: ConnectorTokens): Promise<ConnectorTokens> {
  if (!token.refreshToken || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('google_refresh_unavailable');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: token.refreshToken, grant_type: 'refresh_token' }),
  });
  if (!response.ok) throw new Error(`google_refresh_failed:${response.status}`);
  const data = await response.json() as { access_token: string; expires_in?: number; token_type?: string; scope?: string };
  return { ...token, accessToken: data.access_token, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined, tokenType: data.token_type ?? token.tokenType, scope: data.scope ?? token.scope };
}

async function refreshMicrosoft(env: ApiEnv, token: ConnectorTokens): Promise<ConnectorTokens> {
  if (!token.refreshToken || !env.MICROSOFT_OAUTH_CLIENT_ID || !env.MICROSOFT_OAUTH_CLIENT_SECRET) throw new Error('microsoft_refresh_unavailable');
  const tenant = env.MICROSOFT_TENANT ?? 'common';
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MICROSOFT_OAUTH_CLIENT_ID, client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET, refresh_token: token.refreshToken, grant_type: 'refresh_token', scope: token.scope ?? 'offline_access' }),
  });
  if (!response.ok) throw new Error(`microsoft_refresh_failed:${response.status}`);
  const data = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? token.refreshToken, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined, tokenType: data.token_type, scope: data.scope ?? token.scope };
}

export async function getValidConnectorToken(input: { env: ApiEnv; accessToken: string; userId: string; connectionId: string }): Promise<{ provider: 'google' | 'microsoft'; kind: IntegrationKind; accessToken: string }> {
  const row = await loadConnectionSecret(input.env, input.accessToken, input.userId, input.connectionId);
  if (row.provider !== 'google' && row.provider !== 'microsoft') throw new Error('oauth_provider_unsupported');
  let tokens = await decryptConnectorCredential<ConnectorTokens>(input.env, row.encrypted_credentials!, row.credential_iv!);
  if (tokens.expiresAt && tokens.expiresAt <= Date.now() + 60_000) {
    tokens = row.provider === 'google' ? await refreshGoogle(input.env, tokens) : await refreshMicrosoft(input.env, tokens);
    const encrypted = await encryptConnectorCredential(input.env, tokens);
    await supabaseRest(input.env, input.accessToken, `/rest/v1/integration_connections?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ encrypted_credentials: encrypted.ciphertext, credential_iv: encrypted.iv, status: 'connected', updated_at: new Date().toISOString() }),
    });
  }
  return { provider: row.provider, kind: row.kind, accessToken: tokens.accessToken };
}
