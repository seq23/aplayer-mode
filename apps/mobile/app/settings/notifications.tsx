import { useState } from 'react';
import { Body, Button, Card, CardTitle, Screen, SectionTitle } from '../../src/components/ui';
import { enableApmPush } from '../../src/integrations/push';
import { useSession } from '../../src/state/session';

export default function NotificationsScreen() {
  const { accessToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const enable = async () => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      await enableApmPush(accessToken);
      setMessage('Proactive APM notifications are registered for this device.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to enable notifications.');
    } finally { setBusy(false); }
  };

  return (
    <Screen eyebrow="Notifications" title="APM should interrupt rarely—and usefully." subtitle="Proactive alerts are opt-in. They exist for high-value Radar items, approvals and important changes, not motivational spam.">
      {message ? <Card tone="accent"><Body>{message}</Body></Card> : null}
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      <SectionTitle>Device permission</SectionTitle>
      <Card>
        <CardTitle>Enable proactive APM</CardTitle>
        <Body muted>APM will ask the operating system for notification permission, register this device, and keep private detail minimal on the lock screen by default.</Body>
        <Button label={busy ? 'Enabling…' : 'Enable notifications'} onPress={() => void enable()} />
      </Card>
      <Card tone="warning">
        <CardTitle>Noise suppression is a product requirement.</CardTitle>
        <Body>Radar severity, deduplication, quiet hours and stale-state checks are evaluated server-side before a push is sent.</Body>
      </Card>
    </Screen>
  );
}
