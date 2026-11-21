import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { apiBaseUrl, completeOAuthConnection, fetchOAuthConnectionResult, startOAuthConnection } from '../api/apmApi';
import { ApiError, friendlyApiMessage } from '../api/errors';
import { authStartUrl, openAuthSheet, readOAuthReturn } from './authStart';

WebBrowser.maybeCompleteAuthSession();

export type OAuthProvider = 'google' | 'microsoft';
export type OAuthKind = 'calendar' | 'email';

export async function connectOAuthProvider(input: {
  provider: OAuthProvider;
  kind: OAuthKind;
  accessToken: string;
  /** 'act' = the separate write consent Autopilot classes require (docs/22). */
  access?: 'read' | 'act';
  /** 'add' = another account of this kind (Autopilot only, 0065); 'reconnect' = the same account. */
  intent?: 'add' | 'reconnect';
}) {
  const popup = Platform.OS === 'web' ? window.open('about:blank', '_blank', 'popup') : null;
  if (Platform.OS === 'web' && !popup) throw new Error('Allow pop-ups to connect this account.');
  const redirectUri = 'aplayermode://oauth';
  try {
    const started = await startOAuthConnection({
      provider: input.provider,
      kind: input.kind,
      access: input.access ?? 'read',
      intent: input.intent ?? 'reconnect',
      // Web consent finishes on our own /oauth/complete page, signed in as this same person.
      client: popup ? 'web' : 'app',
    }, input.accessToken);
    if (popup) {
      popup.opener = null;
      popup.location.href = started.authorizationUrl;
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const { connectionId, error } = await fetchOAuthConnectionResult(started.state, input.accessToken);
        if (connectionId) return { connectionId };
        if (error) throw new ApiError(400, { error });
        if (popup.closed) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('Connection could not be confirmed');
    }

    const start = authStartUrl(started.authorizationUrl, { provider: input.provider, returnUrl: redirectUri, apiBase: apiBaseUrl(), platform: Platform.OS });
    const returned = await openAuthSheet(WebBrowser.openAuthSessionAsync, start, redirectUri);
    if (!returned) throw new Error('Connection was cancelled before authorization completed');

    const callback = new URL(returned);
    if (callback.protocol !== 'aplayermode:' || callback.hostname !== 'oauth') throw new Error('Connection could not be confirmed');
    // The server links the account only for the session that started this flow (finding 5).
    const handed = readOAuthReturn(callback.searchParams, started.state);
    if (!handed.ok) throw new Error(friendlyApiMessage(400, { error: handed.error }));
    return await completeOAuthConnection({ state: handed.state, handoff: handed.handoff }, input.accessToken);
  } finally {
    popup?.close();
  }
}
