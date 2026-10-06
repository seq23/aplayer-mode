import { useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { syncCloudCalendar, syncEmailConnection } from '../../../src/api/apmApi';
import { connectOAuthProvider, type OAuthKind, type OAuthProvider } from '../../../src/integrations/oauth';
import { syncConfiguredDeviceCalendars } from '../../../src/integrations/deviceCalendar';
import { useLifeGraph } from '../../../src/state/lifeGraph';
import { useSession } from '../../../src/state/session';

type BusyKey = 'device' | `${OAuthProvider}:${OAuthKind}`;

export default function ConnectionsScreen() {
  const { graph, refresh } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState<BusyKey>();
  const [error, setError] = useState<string>();

  const connect = async (provider: OAuthProvider, kind: OAuthKind) => {
    if (!accessToken || busy) return;
    const key: BusyKey = `${provider}:${kind}`;
    setBusy(key);
    setError(undefined);
    try {
      const connection = await connectOAuthProvider({ provider, kind, accessToken });
      if (kind === 'calendar') await syncCloudCalendar(connection.connectionId, accessToken);
      else await syncEmailConnection(connection.connectionId, accessToken);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect this account.');
    } finally {
      setBusy(undefined);
    }
  };

  const syncDevice = async () => {
    if (!accessToken || busy) return;
    setBusy('device');
    setError(undefined);
    try {
      await syncConfiguredDeviceCalendars(accessToken);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read calendars configured on this device.');
    } finally {
      setBusy(undefined);
    }
  };

  const cards: Array<{
    key: BusyKey;
    title: string;
    detail: string;
    provider?: OAuthProvider;
    kind?: OAuthKind;
    device?: boolean;
  }> = [
    {
      key: 'device',
      title: 'Calendars on this device',
      detail: 'Reads calendar events already configured on this phone. On iPhone this can include iCloud, Google, Outlook/Exchange and other system calendars.',
      device: true,
    },
    { key: 'google:calendar', title: 'Google Calendar', detail: 'Direct cloud calendar sync for background awareness.', provider: 'google', kind: 'calendar' },
    { key: 'microsoft:calendar', title: 'Outlook / Microsoft Calendar', detail: 'Direct Microsoft Graph calendar sync for Outlook.com and Microsoft 365.', provider: 'microsoft', kind: 'calendar' },
    { key: 'google:email', title: 'Gmail', detail: 'Detects commitments, requests, follow-ups and deadlines from permitted email metadata/content.', provider: 'google', kind: 'email' },
    { key: 'microsoft:email', title: 'Outlook / Microsoft Mail', detail: 'Detects commitments and open loops through Microsoft Graph mail access.', provider: 'microsoft', kind: 'email' },
  ];

  return (
    <Screen
      eyebrow="Connections"
      title="You choose what APM can see."
      subtitle="Every account is connected separately. Calendar access never silently grants email access, and email access never grants send authority."
    >
      <Card tone="accent">
        <CardTitle>Provider-neutral Calendar Fabric</CardTitle>
        <Body muted>APM normalizes device, Google, Microsoft and iCloud-backed device calendars into one schedule model while preserving source provenance.</Body>
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>Available connections</SectionTitle>
      <View style={uiStyles.stack}>
        {cards.map((card) => {
          const existing = card.device
            ? graph.connections.find((connection) => connection.provider === 'device' && connection.kind === 'calendar')
            : graph.connections.find((connection) => connection.provider === card.provider && connection.kind === card.kind);
          return (
            <Card key={card.key}>
              <View style={uiStyles.row}>
                <CardTitle>{card.title}</CardTitle>
                <Pill tone={existing?.status === 'connected' ? 'success' : undefined}>{existing?.status ?? 'Not connected'}</Pill>
              </View>
              <Body muted>{card.detail}</Body>
              {existing ? (
                <>
                  <KeyValue label="Account" value={existing.accountLabel ?? 'Connected account'} />
                  <KeyValue label="Scopes" value={existing.scopes.length ? existing.scopes.join(', ') : 'Device permission'} />
                  <KeyValue label="Last sync" value={existing.lastSyncAt ?? 'Not synced yet'} />
                </>
              ) : null}
              <Button
                label={busy === card.key ? 'Connecting / syncing…' : card.device ? 'Read & sync device calendars' : existing ? 'Reconnect / refresh authorization' : `Connect ${card.title}`}
                variant="secondary"
                onPress={() => card.device ? void syncDevice() : void connect(card.provider!, card.kind!)}
              />
            </Card>
          );
        })}
      </View>

      <Card tone="warning">
        <CardTitle>Least privilege first.</CardTitle>
        <Body>APM requests only the scopes needed for the selected capability. Write/send permissions remain separate and require explicit autonomy settings.</Body>
      </Card>
    </Screen>
  );
}
