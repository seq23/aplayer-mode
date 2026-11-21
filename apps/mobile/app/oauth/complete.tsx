import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Body, Button, Screen } from '../../src/components/ui';
import { completeOAuthConnection } from '../../src/api/apmApi';
import { friendlyApiMessage, plainError } from '../../src/api/errors';
import { useSession } from '../../src/state/session';

/**
 * Web only: where a calendar or mail connect lands after Google or Microsoft (finding 5). The
 * one-time handoff arrives in the URL fragment; this page sends it with the session signed in
 * in this browser, and the server links the account only if that session started the flow.
 * The tab that started the connect sees the result on its own and this window closes.
 */
export default function OAuthComplete() {
  const { accessToken, status } = useSession();
  const [message, setMessage] = useState('Connecting your account…');
  const [done, setDone] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || sent.current || status === 'loading') return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // The secret never stays in the address bar or the history.
    window.history.replaceState(null, '', window.location.pathname);
    sent.current = true;
    const error = params.get('error');
    const state = params.get('state');
    const handoff = params.get('handoff');
    if (error || !state || !handoff) {
      setMessage(friendlyApiMessage(400, { error: error ?? 'invalid_oauth_state' }));
      setDone(true);
      return;
    }
    if (!accessToken) {
      setMessage('Sign in to A Player Mode in this browser, then connect again from Settings → Connections.');
      setDone(true);
      return;
    }
    completeOAuthConnection({ state, handoff }, accessToken)
      .then(() => { setMessage('Connected. You can close this window.'); window.close(); })
      .catch((cause) => setMessage(plainError(cause, 'The account didn’t connect. Try again.')))
      .finally(() => setDone(true));
  }, [accessToken, status]);

  return (
    <Screen fullBleed eyebrow="A Player Mode" title="Connections">
      <Body muted>{message}</Body>
      {done ? <Button label="Open A Player Mode" onPress={() => router.replace('/settings/privacy/connections')} /> : null}
    </Screen>
  );
}
