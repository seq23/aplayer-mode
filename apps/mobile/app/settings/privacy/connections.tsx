import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { IntegrationConnection } from '@apm/domain';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  TextField,
  uiStyles,
} from '../../../src/components/ui';
import {
  disconnectConnection,
  reactivateConnection,
  setConnectionLabel,
  setPrimaryConnection,
  syncCloudCalendar,
  syncEmailConnection,
} from '../../../src/api/apmApi';
import { connectOAuthProvider, type OAuthKind, type OAuthProvider } from '../../../src/integrations/oauth';
import { accountName, accountsOfKind, addAnotherAccount, hasMultiAccount, KIND_NOUN, pausedNote } from '../../../src/integrations/accounts';
import { syncConfiguredDeviceCalendars } from '../../../src/integrations/deviceCalendar';
import { useLifeGraph } from '../../../src/state/lifeGraph';
import { useSession } from '../../../src/state/session';

// The provider write scopes the Autopilot claim checks (migration 0033 required_scopes).
const WRITE_SCOPES: Record<OAuthKind, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events', 'Calendars.ReadWrite'],
  email: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'Mail.Send', 'Mail.ReadWrite'],
};
const hasWriteScope = (kind: OAuthKind, scopes: string[]) => scopes.some((scope) => WRITE_SCOPES[kind].includes(scope));

const PROVIDER_NAMES: Record<OAuthKind, Record<OAuthProvider, string>> = {
  calendar: { google: 'Google Calendar', microsoft: 'Outlook / Microsoft Calendar' },
  email: { google: 'Gmail', microsoft: 'Outlook / Microsoft Mail' },
};
const KIND_TITLES: Record<OAuthKind, string> = { calendar: 'Calendars', email: 'Inboxes' };
const KIND_DETAIL: Record<OAuthKind, string> = {
  calendar: 'Direct cloud calendar sync. Conflicts are checked across every calendar you connect, so work never double-books personal.',
  email: 'Detects commitments, requests, follow-ups and deadlines from permitted email metadata/content.',
};

export default function ConnectionsScreen() {
  const { graph, refresh } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const multi = hasMultiAccount(graph.entitlement);

  const run = async (key: string, work: (token: string) => Promise<unknown>, fallback: string) => {
    if (!accessToken || busy) return;
    setBusy(key);
    setError(undefined);
    try {
      await work(accessToken);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(undefined);
    }
  };

  const connect = (provider: OAuthProvider, kind: OAuthKind, intent: 'add' | 'reconnect', access: 'read' | 'act' = 'read') =>
    run(`${provider}:${kind}:${intent}:${access}`, async (token) => {
      const connection = await connectOAuthProvider({ provider, kind, accessToken: token, access, intent });
      if (kind === 'calendar') await syncCloudCalendar(connection.connectionId, token);
      else await syncEmailConnection(connection.connectionId, token);
    }, 'Unable to connect this account.');

  const sync = (account: IntegrationConnection) => run(`sync:${account.id}`, (token) =>
    account.kind === 'calendar' ? syncCloudCalendar(account.id, token) : syncEmailConnection(account.id, token), 'Unable to sync this account.');

  const accountCard = (account: IntegrationConnection) => {
    const kind = account.kind as OAuthKind;
    const provider = account.provider as OAuthProvider;
    const note = pausedNote(account, graph.entitlement);
    const draft = labels[account.id] ?? account.label ?? '';
    return (
      <Card key={account.id} tone={account.pausedAt ? 'muted' : 'default'}>
        <View style={uiStyles.row}>
          <CardTitle>{accountName(account)}</CardTitle>
          {account.isPrimary ? <Pill tone="success">Primary</Pill> : null}
          <Pill tone={account.pausedAt ? 'warning' : account.status === 'connected' ? 'success' : undefined}>{account.pausedAt ? 'Paused' : account.status}</Pill>
        </View>
        <KeyValue label="Provider" value={PROVIDER_NAMES[kind]?.[provider] ?? account.provider} />
        <KeyValue label="Account" value={account.accountLabel ?? 'Connected account'} />
        <KeyValue label="Last sync" value={account.lastSyncAt ?? 'Not synced yet'} />
        <KeyValue label="Autopilot can act" value={hasWriteScope(kind, account.scopes) ? 'Yes · write consent given' : 'No · read only'} />
        {note ? <Body>{note}</Body> : null}
        <TextField label="Your name for this account" placeholder="Work, Personal…" value={draft} onChangeText={(value) => setLabels((current) => ({ ...current, [account.id]: value }))} />
        {draft.trim() !== (account.label ?? '') ? (
          <Button label={busy === `label:${account.id}` ? 'Saving…' : 'Save name'} variant="secondary"
            onPress={() => void run(`label:${account.id}`, (token) => setConnectionLabel(account.id, draft.trim() || null, token), 'Unable to rename this account.')} />
        ) : null}
        {!account.isPrimary ? (
          <Button label={busy === `primary:${account.id}` ? 'Switching…' : `Make this my primary ${KIND_NOUN[kind]}`} variant="secondary"
            onPress={() => void run(`primary:${account.id}`, (token) => setPrimaryConnection(account.id, token), 'Unable to change the primary account.')} />
        ) : null}
        {account.pausedAt && multi ? (
          <Button label={busy === `reactivate:${account.id}` ? 'Reactivating…' : 'Reactivate'} variant="secondary"
            onPress={() => void run(`reactivate:${account.id}`, (token) => reactivateConnection(account.id, token), 'Unable to reactivate this account.')} />
        ) : null}
        {!account.pausedAt ? (
          <>
            <Button label={busy === `sync:${account.id}` ? 'Syncing…' : 'Sync now'} variant="secondary" onPress={() => void sync(account)} />
            <Button
              label={hasWriteScope(kind, account.scopes) ? 'Refresh Autopilot write consent' : 'Allow Autopilot to act on this account'}
              variant="secondary"
              onPress={() => void connect(provider, kind, 'reconnect', 'act')}
            />
          </>
        ) : null}
        <Button label={busy === `disconnect:${account.id}` ? 'Disconnecting…' : 'Disconnect'} variant="danger"
          onPress={() => void run(`disconnect:${account.id}`, (token) => disconnectConnection(account.id, token), 'Unable to disconnect this account.')} />
      </Card>
    );
  };

  const kindSection = (kind: OAuthKind) => {
    const accounts = accountsOfKind(graph.connections, kind);
    const add = addAnotherAccount(graph.entitlement, graph.connections, kind);
    const intent = accounts.length ? 'add' : 'reconnect';
    return (
      <View key={kind} style={uiStyles.stack}>
        <SectionTitle>{KIND_TITLES[kind]}</SectionTitle>
        <Body muted>{KIND_DETAIL[kind]}</Body>
        {accounts.map(accountCard)}
        {add.allowed ? (
          <Card>
            <CardTitle>{accounts.length ? 'Add another account' : `Connect a ${KIND_NOUN[kind]}`}</CardTitle>
            {(['google', 'microsoft'] as const).map((provider) => (
              <Button key={provider} label={busy === `${provider}:${kind}:${intent}:read` ? 'Connecting / syncing…' : `Connect ${PROVIDER_NAMES[kind][provider]}`}
                variant="secondary" onPress={() => void connect(provider, kind, intent)} />
            ))}
          </Card>
        ) : (
          <Card tone="accent">
            <CardTitle>Add another account</CardTitle>
            <Body>{add.upgradeNote}</Body>
            <Button label="See plans" variant="secondary" onPress={() => router.push('/settings/plan')} />
          </Card>
        )}
      </View>
    );
  };

  const deviceConnected = graph.connections.some((connection) => connection.provider === 'device' && connection.kind === 'calendar');

  return (
    <Screen
      eyebrow="Connections"
      title="You choose what APM can see."
      subtitle="Every account is connected separately. Calendar access never silently grants email access, and reading never grants write or send authority: that is a separate consent you give per account."
    >
      <Card tone="accent">
        <CardTitle>Provider-neutral Calendar Fabric</CardTitle>
        <Body muted>APM normalizes device, Google, Microsoft and iCloud-backed device calendars into one schedule model while preserving which account each event came from.</Body>
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>This device</SectionTitle>
      <Card>
        <View style={uiStyles.row}>
          <CardTitle>Calendars on this device</CardTitle>
          <Pill tone={deviceConnected ? 'success' : undefined}>{deviceConnected ? 'connected' : 'Not connected'}</Pill>
        </View>
        <Body muted>Reads calendar events already configured on this phone. On iPhone this can include iCloud, Google, Outlook/Exchange and other system calendars.</Body>
        <Button
          label={busy === 'device' ? 'Connecting / syncing…' : 'Read & sync device calendars'}
          variant="secondary"
          onPress={() => void run('device', (token) => syncConfiguredDeviceCalendars(token), 'Unable to read calendars configured on this device.')}
        />
      </Card>

      {(['calendar', 'email'] as const).map(kindSection)}

      <Card tone="warning">
        <CardTitle>Least privilege first.</CardTitle>
        <Body>APM requests only the scopes needed for the selected capability. Write/send permissions remain separate and require explicit autonomy settings. Disconnecting always works, on every plan.</Body>
      </Card>
    </Screen>
  );
}
