import { useEffect, useState } from 'react';
import { Body, Button, Card, CardTitle, ChoiceRow, ErrorState, KeyValue, Label, Screen, SectionTitle, Toast } from '../../src/components/ui';
import { TimePicker } from '../../src/components/TimePickerField';
import { fetchNotificationPreferences, saveNotificationPreferences, type NotificationPreferences } from '../../src/api/apmApi';
import { enableApmPush } from '../../src/integrations/push';
import { useSession } from '../../src/state/session';

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export default function NotificationsScreen() {
  const { accessToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [prefs, setPrefs] = useState<NotificationPreferences>();
  const [wakeTime, setWakeTime] = useState('07:00');
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');

  useEffect(() => {
    if (!accessToken) return;
    void fetchNotificationPreferences(accessToken).then(({ preferences }) => {
      if (!preferences) return;
      setPrefs(preferences);
      setWakeTime(preferences.wake_time);
      setQuietStart(preferences.quiet_hours?.start ?? '');
      setQuietEnd(preferences.quiet_hours?.end ?? '');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load notification settings.'));
  }, [accessToken]);

  const run = async (call: () => Promise<void>) => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined); setMessage(undefined);
    try { await call(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save.'); } finally { setBusy(false); }
  };
  const save = (input: Parameters<typeof saveNotificationPreferences>[0], done: string) => run(async () => {
    const { preferences } = await saveNotificationPreferences(input, accessToken!);
    if (preferences) setPrefs(preferences);
    setMessage(done);
  });
  const enable = () => run(async () => {
    await enableApmPush(accessToken!);
    setMessage('Proactive APM notifications are registered for this device.');
  });
  const saveMorning = () => {
    if (!HHMM.test(wakeTime)) { setError('Choose a wake time first.'); return; }
    void save({ wakeTime }, `Your agenda will be printed and delivered at ${wakeTime} your time.`);
  };
  const saveQuiet = () => {
    if (!quietStart && !quietEnd) { void save({ quietHours: {} }, 'Quiet hours removed.'); return; }
    if (!HHMM.test(quietStart) || !HHMM.test(quietEnd)) { setError('Choose both a start and an end for quiet hours, or clear both.'); return; }
    void save({ quietHours: { start: quietStart, end: quietEnd } }, `Quiet ${quietStart}–${quietEnd} (your local time).`);
  };

  return (
    <Screen eyebrow="Notifications" title="APM should interrupt rarely—and usefully." subtitle="One morning trigger with your agenda, high-value Radar items and approvals. No motivational spam.">
      <Toast tone="success" message={message} />
      {error ? <ErrorState message={error} /> : null}

      <SectionTitle>Device permission</SectionTitle>
      <Card>
        <CardTitle>Enable proactive APM</CardTitle>
        <Body muted>APM asks the operating system for permission, registers this device, and keeps private detail minimal on the lock screen by default.</Body>
        <Button label={busy ? 'Enabling…' : 'Enable notifications'} onPress={() => void enable()} />
      </Card>

      <SectionTitle>Morning Trigger</SectionTitle>
      <Card tone="accent">
        <CardTitle>“Coach, give me my agenda” — automatically.</CardTitle>
        <Body muted>At your wake time APM prints today’s agenda and sends one notification. It never sends during a Deep Work block or a protected family block; it waits until the block ends.</Body>
        <KeyValue label="Status" value={prefs?.morning_push_enabled === false ? 'Off' : 'On'} />
        <ChoiceRow options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} value={prefs?.morning_push_enabled === false ? 'off' : 'on'} onChange={(value) => void save({ morningPushEnabled: value === 'on' }, value === 'on' ? 'Morning Trigger on.' : 'Morning Trigger off.')} />
        <TimePicker label="Wake time (your local time)" value={wakeTime} onChange={setWakeTime} />
        <Button label={busy ? 'Saving…' : 'Save wake time'} onPress={saveMorning} />
      </Card>

      <SectionTitle>Lock screen and quiet hours</SectionTitle>
      <Card>
        <Label>Lock-screen detail</Label>
        <ChoiceRow options={[{ id: 'minimal', label: 'Minimal' }, { id: 'normal', label: 'Show the foreground' }]} value={prefs?.lock_screen_detail ?? 'minimal'} onChange={(value) => void save({ lockScreenDetail: value }, value === 'minimal' ? 'Lock screen shows no private detail.' : 'Lock screen shows today’s foreground.')} />
        <TimePicker label="Quiet from" value={quietStart} onChange={setQuietStart} placeholder="No quiet hours" allowClear />
        <TimePicker label="Quiet until" value={quietEnd} onChange={setQuietEnd} placeholder="No quiet hours" allowClear />
        <Button label="Save quiet hours" variant="secondary" onPress={saveQuiet} />
        <Body muted>Quiet hours use your local clock. Critical Radar items can still come through.</Body>
      </Card>

      <SectionTitle>All notifications</SectionTitle>
      <Card tone="warning">
        <CardTitle>Turn every APM notification off</CardTitle>
        <ChoiceRow options={[{ id: 'on', label: 'Notifications on' }, { id: 'off', label: 'All off' }]} value={prefs?.enabled === false ? 'off' : 'on'} onChange={(value) => void save({ enabled: value === 'on' }, value === 'on' ? 'Notifications on.' : 'All APM notifications are off.')} />
        <Body>Radar severity, deduplication, quiet hours and stale-state checks are evaluated server-side before a push is sent.</Body>
      </Card>
    </Screen>
  );
}
