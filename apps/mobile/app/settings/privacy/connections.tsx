import { syncedWords } from '../../../src/content/words';
import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { IntegrationConnection } from '@apm/domain';
import {
  AnswerCard,
  Body,
  Button,
  Card,
  CardTitle,
  ErrorState,
  KeyValue,
  Label,
  Muted,
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
import { chooseCalendars, chosenCalendars, listPhoneCalendars, removePhoneCalendarEvents, syncChosenDeviceCalendars, type PhoneCalendar } from '../../../src/integrations/deviceCalendar';
import { useLifeGraph } from '../../../src/state/lifeGraph';
import { useSession } from '../../../src/state/session';
import { plainError } from '../../../src/api/errors';

// The provider write scopes the Autopilot claim checks (migration 0033 required_scopes).
const WRITE_SCOPES: Record<OAuthKind, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events', 'Calendars.ReadWrite'],
  email: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'Mail.Send'],
};
const hasWriteScope = (kind: OAuthKind, scopes: string[]) => scopes.some((scope) => WRITE_SCOPES[kind].includes(scope));

const PROVIDER_NAMES: Record<OAuthKind, Record<OAuthProvider, string>> = {
  calendar: { google: 'Google Calendar', microsoft: 'Outlook / Microsoft Calendar' },
  email: { google: 'Gmail', microsoft: 'Outlook / Microsoft Mail' },
};
const KIND_TITLES: Record<OAuthKind, string> = { calendar: 'Calendars', email: 'Inboxes' };
const KIND_DETAIL: Record<OAuthKind, string> = {
  calendar: 'Direct cloud calendar sync. Conflicts are checked across every calendar you connect, so work never double-books personal.',
  email: 'Connect Outlook Mail for commitments and reply drafts. Google connects your calendar.',
};

export default function ConnectionsScreen() {
  const { graph, refresh } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Phone calendars (issue #82): the person picks which ones sync; nothing is pre-ticked.
  const [chosen, setChosen] = useState<PhoneCalendar[] | null>(() => chosenCalendars());
  const [picker, setPicker] = useState<PhoneCalendar[]>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [phoneNote, setPhoneNote] = useState<string>();
  const multi = hasMultiAccount(graph.entitlement);

  const run = async (key: string, work: (token: string) => Promise<unknown>, fallback: string) => {
    if (busy) return;
    if (!accessToken) { setError('Sign in first, then try again.'); return; }
    setBusy(key);
    setError(undefined);
    try {
      await work(accessToken);
      await refresh();
    } catch (cause) {
      await refresh().catch(() => undefined);
      setError(plainError(cause, fallback));
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
    const supported = kind !== 'email' || provider === 'microsoft';
    return (
      <Card key={account.id} tone={account.pausedAt ? 'muted' : 'default'}>
        <View style={uiStyles.row}>
          <CardTitle>{accountName(account)}</CardTitle>
          {account.isPrimary ? <Pill tone="success">Primary</Pill> : null}
          <Pill tone={account.pausedAt ? 'warning' : account.status === 'connected' ? 'success' : undefined}>{account.pausedAt ? 'Paused' : account.status === 'needs_reauth' ? 'Needs reconnecting' : account.status === 'error' ? 'Not responding, retrying' : account.status === 'connected' ? 'Connected' : account.status}</Pill>
        </View>
        <KeyValue label="Provider" value={PROVIDER_NAMES[kind]?.[provider] ?? account.provider} />
        <KeyValue label="Account" value={account.accountLabel ?? 'Connected account'} />
        <KeyValue label="Last sync" value={syncedWords(account.lastSyncAt)} />
        <KeyValue label="Account write access" value={hasWriteScope(kind, account.scopes) ? 'Yes · write consent given' : 'No · read only'} />
        {supported && note ? <Body>{note}</Body> : null}
        {!supported ? <Body>Disconnect Gmail to free this inbox slot for Outlook Mail.</Body> : null}
        <TextField label="Your name for this account" placeholder="Work, Personal…" value={draft} onChangeText={(value) => setLabels((current) => ({ ...current, [account.id]: value }))} />
        {draft.trim() !== (account.label ?? '') ? (
          <Button label={busy === `label:${account.id}` ? 'Saving…' : 'Save name'} variant="secondary"
            onPress={() => void run(`label:${account.id}`, (token) => setConnectionLabel(account.id, draft.trim() || null, token), 'Unable to rename this account.')} />
        ) : null}
        {!account.isPrimary ? (
          <Button label={busy === `primary:${account.id}` ? 'Switching…' : `Make this my primary ${KIND_NOUN[kind]}`} variant="secondary"
            onPress={() => void run(`primary:${account.id}`, (token) => setPrimaryConnection(account.id, token), 'Unable to change the primary account.')} />
        ) : null}
        {account.pausedAt && multi && supported ? (
          <Button label={busy === `reactivate:${account.id}` ? 'Reactivating…' : 'Reactivate'} variant="secondary"
            onPress={() => void run(`reactivate:${account.id}`, (token) => reactivateConnection(account.id, token), 'Unable to reactivate this account.')} />
        ) : null}
        {!account.pausedAt && supported && account.status === 'needs_reauth' ? <Button
          label={`Reconnect ${PROVIDER_NAMES[kind][provider]}`} variant="secondary"
          onPress={() => void connect(provider, kind, 'reconnect', hasWriteScope(kind, account.scopes) ? 'act' : 'read')} /> : null}
        {!account.pausedAt && supported && account.status !== 'needs_reauth' ? (
          <>
            <Button label={busy === `sync:${account.id}` ? 'Syncing…' : 'Sync now'} variant="secondary" onPress={() => void sync(account)} />
            <Button
              label={hasWriteScope(kind, account.scopes) ? 'Refresh write consent' : 'Allow writes on this account'}
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
            {(['google', 'microsoft'] as const).filter((provider) => kind === 'calendar' || provider === 'microsoft').map((provider) => (
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

  const phoneEventsStored = graph.calendarEvents.some((event) => event.provider === 'device' && !event.connectionId);
  // Listing the phone's calendars needs no account call, so it never waits on a session.
  const openPicker = async () => {
    if (busy) return;
    setBusy('device:list');
    setError(undefined);
    try {
      const calendars = await listPhoneCalendars();
      setTicked(new Set((chosen ?? []).map((calendar) => calendar.id).filter((id) => calendars.some((calendar) => calendar.id === id))));
      setConfirmRemove(false);
      setPhoneNote(undefined);
      setPicker(calendars);
    } catch (cause) {
      setError(plainError(cause, 'Unable to read the calendars on this phone.'));
    } finally {
      setBusy(undefined);
    }
  };
  const toggle = (id: string) => setTicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const saveChoice = () => run('device:save', async (token) => {
    const picked = (picker ?? []).filter((calendar) => ticked.has(calendar.id));
    await chooseCalendars(picked, token);
    setChosen(picked);
    setPicker(undefined);
    setPhoneNote(`✓ Synced ${picked.length === 1 ? '1 calendar' : `${picked.length} calendars`}. Calendars you did not tick were removed from APM.`);
  }, 'Unable to sync the calendars you picked.');
  const removePhoneEvents = () => run('device:remove', async (token) => {
    await removePhoneCalendarEvents(token);
    setChosen(null);
    setConfirmRemove(false);
    setPhoneNote('✓ Removed. APM keeps no events from this phone’s calendars. To stop APM seeing them at all, turn off Calendars for A Player Mode in your phone’s Settings.');
  }, 'Unable to remove phone calendar events.');
  const pickedCount = ticked.size;

  return (
    <Screen
      title="You choose what APM can see."
      subtitle="Every account is connected separately. Calendar access never silently grants email access, and reading never grants write or send authority: that is a separate consent you give per account."
    >
      <Card tone="accent">
        <CardTitle>All your calendars in one day</CardTitle>
        <Body muted>APM puts the calendars on this phone, Google and Outlook into one schedule, and always shows which account each event came from.</Body>
      </Card>

      {error ? <ErrorState message={error} /> : null}

      <SectionTitle>This phone</SectionTitle>
      <Card>
        <View style={uiStyles.row}>
          <CardTitle>Calendars on this phone</CardTitle>
          <Pill tone={chosen?.length ? 'success' : undefined}>{chosen?.length ? `${chosen.length} syncing` : 'Not connected'}</Pill>
        </View>
        {picker ? (
          <>
            <Label>Tick the calendars APM may read</Label>
            <Muted>Your phone lets APM see every calendar on it. APM reads only the ones you tick; the rest stay on your phone.</Muted>
            {picker.length ? picker.map((calendar) => (
              <AnswerCard key={calendar.id} role="checkbox" label={calendar.title} detail={calendar.account || undefined}
                selected={ticked.has(calendar.id)} onPress={() => toggle(calendar.id)} />
            )) : <Body>There are no calendars on this phone yet.</Body>}
            <Button label={busy === 'device:save' ? 'Syncing…' : pickedCount ? `Sync ${pickedCount === 1 ? '1 calendar' : `${pickedCount} calendars`}` : 'Sync calendars'}
              disabled={!pickedCount} disabledReason="Tick at least one calendar first." busy={busy === 'device:save'} onPress={() => void saveChoice()} />
            <Button label="✕ Cancel" variant="secondary" onPress={() => setPicker(undefined)} />
          </>
        ) : chosen?.length ? (
          <>
            <KeyValue label="Syncing" value={chosen.map((calendar) => calendar.title).join(', ')} />
            <Muted>Events from 14 days ago to 90 days ahead, from these calendars only.</Muted>
            <Button label={busy === 'device:sync' ? 'Syncing…' : 'Sync now'} variant="secondary"
              onPress={() => void run('device:sync', (token) => syncChosenDeviceCalendars(token), 'Unable to sync the calendars on this phone.')} />
            <Button label={busy === 'device:list' ? 'Opening…' : 'Change calendars ▾'} variant="secondary" onPress={() => void openPicker()} />
          </>
        ) : (
          <>
            <Body muted>Pick which calendars on this phone APM may read. On iPhone these can include iCloud, Google, Outlook/Exchange and other accounts on the phone.</Body>
            <Button label={busy === 'device:list' ? 'Opening…' : 'Choose calendars ▾'} variant="secondary" onPress={() => void openPicker()} />
          </>
        )}
        {phoneNote ? <Body>{phoneNote}</Body> : null}
      </Card>
      {!picker && (chosen?.length || phoneEventsStored) ? (
        <Card tone="muted">
          <CardTitle>Remove phone calendar events</CardTitle>
          <Body muted>Deletes every event from this phone’s calendars that APM has stored. Your phone’s calendars are not changed.</Body>
          {confirmRemove ? (
            <>
              <Body>Remove them now? APM will plan without them until you choose calendars again.</Body>
              <Button label={busy === 'device:remove' ? 'Removing…' : 'Yes, remove'} variant="danger" busy={busy === 'device:remove'} onPress={() => void removePhoneEvents()} />
              <Button label="Keep" variant="secondary" onPress={() => setConfirmRemove(false)} />
            </>
          ) : (
            <Button label="Remove phone calendar events" variant="danger" onPress={() => setConfirmRemove(true)} />
          )}
        </Card>
      ) : null}

      {(['calendar', 'email'] as const).map(kindSection)}

      <Card tone="warning">
        <CardTitle>Least privilege first.</CardTitle>
        <Body>APM requests only the scopes needed for the selected capability. Write/send permissions remain separate and require explicit autonomy settings. Disconnecting always works, on every plan.</Body>
      </Card>
    </Screen>
  );
}
