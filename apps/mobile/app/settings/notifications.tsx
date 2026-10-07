import { useEffect, useState } from 'react';
import { Body, Button, Card, CardTitle, ChoiceRow, ErrorState, KeyValue, Label, Screen, SectionTitle, Toast, clockText } from '../../src/components/ui';
import { TimePicker } from '../../src/components/TimePickerField';
import { fetchNotificationPreferences, saveNotificationPreferences, type NotificationPreferences } from '../../src/api/apmApi';
import { enableApmPush } from '../../src/integrations/push';
import { useSession } from '../../src/state/session';
import { plainError } from '../../src/api/errors';

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
    }).catch((cause: unknown) => setError(plainError(cause, 'Unable to load notification settings.')));
  }, [accessToken]);

  const run = async (call: () => Promise<void>) => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined); setMessage(undefined);
    try { await call(); } catch (cause) { setError(plainError(cause, 'Unable to save.')); } finally { setBusy(false); }
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
    void save({ wakeTime }, `Your plan will arrive at ${clockText(wakeTime) || wakeTime} your time.`);
  };
  const saveQuiet = () => {
    if (!quietStart && !quietEnd) { void save({ quietHours: {} }, 'Quiet hours removed.'); return; }
    if (!HHMM.test(quietStart) || !HHMM.test(quietEnd)) { setError('Choose both a start and an end for quiet hours, or clear both.'); return; }
    void save({ quietHours: { start: quietStart, end: quietEnd } }, `Quiet from ${clockText(quietStart)} to ${clockText(quietEnd)}.`);
  };

  return (
    <Screen title="Rare, and only when it matters." subtitle="Your morning plan, approvals that need you and urgent heads-ups. No motivational spam.">
      <Toast tone="success" message={message} />
      {error ? <ErrorState message={error} /> : null}

      <SectionTitle>Device permission</SectionTitle>
      <Card>
        <CardTitle>Let APM reach this phone</CardTitle>
        <Body muted>Your phone asks you once. The lock screen shows no private detail unless you choose it below.</Body>
        <Button label={busy ? 'Enabling…' : 'Enable notifications'} onPress={() => void enable()} />
      </Card>

      <SectionTitle>Your morning plan</SectionTitle>
      <Card tone="accent">
        <CardTitle>Your plan arrives on its own.</CardTitle>
        <Body muted>At your wake time APM sets up today's plan and sends one notification. Never during a focus block or family time; it waits until that ends.</Body>
        <KeyValue label="Status" value={prefs?.morning_push_enabled === false ? 'Off' : 'On'} />
        <ChoiceRow options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} value={prefs?.morning_push_enabled === false ? 'off' : 'on'} onChange={(value) => void save({ morningPushEnabled: value === 'on' }, value === 'on' ? 'Morning plan notification on.' : 'Morning plan notification off.')} />
        <TimePicker label="Wake time (your local time)" value={wakeTime} onChange={setWakeTime} />
        <Button label={busy ? 'Saving…' : 'Save wake time'} onPress={saveMorning} />
      </Card>

      <SectionTitle>Lock screen and quiet hours</SectionTitle>
      <Card>
        <Label>Lock-screen detail</Label>
        <ChoiceRow options={[{ id: 'minimal', label: 'Minimal' }, { id: 'normal', label: 'Show my main goal' }]} value={prefs?.lock_screen_detail ?? 'minimal'} onChange={(value) => void save({ lockScreenDetail: value }, value === 'minimal' ? 'Lock screen shows no private detail.' : 'Lock screen shows today’s main goal.')} />
        <TimePicker label="Quiet from" value={quietStart} onChange={setQuietStart} placeholder="No quiet hours" allowClear />
        <TimePicker label="Quiet until" value={quietEnd} onChange={setQuietEnd} placeholder="No quiet hours" allowClear />
        <Button label="Save quiet hours" variant="secondary" onPress={saveQuiet} />
        <Body muted>Quiet hours use your local clock. Critical Radar items can still come through.</Body>
      </Card>

      <SectionTitle>All notifications</SectionTitle>
      <Card tone="warning">
        <CardTitle>Turn every APM notification off</CardTitle>
        <ChoiceRow options={[{ id: 'on', label: 'Notifications on' }, { id: 'off', label: 'All off' }]} value={prefs?.enabled === false ? 'off' : 'on'} onChange={(value) => void save({ enabled: value === 'on' }, value === 'on' ? 'Notifications on.' : 'All APM notifications are off.')} />
        <Body muted>Before anything is sent, APM checks it is urgent, not a repeat, still true, and outside your quiet hours.</Body>
      </Card>
    </Screen>
  );
}
