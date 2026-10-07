import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { exchangeOAuthConnection, startOAuthConnection } from '../api/apmApi';

WebBrowser.maybeCompleteAuthSession();

export type OAuthProvider = 'google' | 'microsoft';
export type OAuthKind = 'calendar' | 'email';

function base64Url(value: string): string {
  return value.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomVerifier(): string {
  return `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replaceAll('-', '');
}

/** Runs Authorization Code + PKCE without exposing provider client secrets in the app. */
export async function connectOAuthProvider(input: {
  provider: OAuthProvider;
  kind: OAuthKind;
  accessToken: string;
  /** 'act' = the separate write consent Autopilot classes require (docs/22). */
  access?: 'read' | 'act';
}) {
  const redirectUri = makeRedirectUri({ scheme: 'aplayermode', path: 'oauth' });
  const codeVerifier = randomVerifier();
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const codeChallenge = base64Url(digest);

  const started = await startOAuthConnection({
    provider: input.provider,
    kind: input.kind,
    codeChallenge,
    redirectUri,
    access: input.access ?? 'read',
  }, input.accessToken);

  const result = await WebBrowser.openAuthSessionAsync(started.authorizationUrl, redirectUri);
  if (result.type !== 'success' || !result.url) throw new Error('Connection was cancelled before authorization completed');

  const callback = new URL(result.url);
  const error = callback.searchParams.get('error');
  if (error) throw new Error(`Provider authorization failed: ${error}`);
  const code = callback.searchParams.get('code');
  const state = callback.searchParams.get('state');
  if (!code || !state) throw new Error('Provider callback did not include authorization code and state');
  if (state !== started.state) throw new Error('OAuth state mismatch');

  return exchangeOAuthConnection({
    provider: input.provider,
    kind: input.kind,
    code,
    codeVerifier,
    state,
    redirectUri,
  }, input.accessToken);
}
