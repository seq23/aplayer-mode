import { useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, ChoiceRow, ErrorState, KeyValue, ListRow, Muted, Screen, SectionTitle, Toast } from '../../src/components/ui';
import { useTheme, type SchemePreference } from '../../src/theme';
import { useSession } from '../../src/state/session';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { PLAN_PRICES } from '@apm/policy';
import { requestDeletion } from '../../src/api/apmApi';
import { plainError } from '../../src/api/errors';
import { UNAVAILABLE_COPY, billingAvailability, restoreStorePurchases } from '../../src/billing/purchases';

/** The three plans by their ONE display name (ADR-0006); never retyped here. */
const PLAN_TITLES = (['chief_of_staff', 'life_os', 'autopilot'] as const).map((plan) => PLAN_PRICES[plan].displayName).join(' · ');

export default function SettingsScreen() {
  const { user, status, accessToken, signOut } = useSession();
  const { refresh } = useLifeGraph();
  const [busy, setBusy] = useState<'restore' | 'delete' | 'signout'>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { preference, setPreference } = useTheme();

  const handleSignOut = async () => {
    if (busy) return;
    setBusy('signout'); setError(undefined);
    try { await signOut(); router.replace('/welcome'); }
    catch (cause) { setError(plainError(cause, 'Sign-out did not finish. Try again.')); }
    finally { setBusy(undefined); }
  };

  // Restore Purchases lives here as well as on the paywall (App Review 3.1.1).
  const restore = async () => {
    if (busy) return;
    const availability = billingAvailability();
    if (!availability.available) { setNotice(UNAVAILABLE_COPY[availability.reason]); return; }
    setBusy('restore'); setError(undefined); setNotice(undefined);
    try {
      await restoreStorePurchases();
      await refresh().catch(() => undefined);
      setNotice('Restore sent to the store. Any active subscription shows under Your plan as soon as the store confirms it.');
    } catch (cause) { setError(plainError(cause, 'Restore did not finish. Try again.')); }
    finally { setBusy(undefined); }
  };

  // Account deletion in two taps from Settings: "Delete my account", then "Delete everything".
  // It calls the real data-rights delete (POST /v1/privacy/delete), then signs out.
  const deleteAccount = async () => {
    if (busy || !accessToken) return;
    setBusy('delete'); setError(undefined);
    try {
      await requestDeletion(accessToken);
      await signOut().catch(() => undefined);
      router.replace({ pathname: '/welcome', params: { deleted: '1' } });
    } catch (cause) { setError(plainError(cause, 'Deletion was not requested. Check your connection and try again.')); }
    finally { setBusy(undefined); }
  };

  return (
    <Screen eyebrow="Settings" title="Your A Player Mode." subtitle="Control how APM understands, connects and acts.">
      {error ? <ErrorState message={error} /> : null}
      <Toast message={notice} />

      <SectionTitle>Account</SectionTitle>
      <Card>
        <CardTitle>{status === 'signed_in' ? 'Private APM account' : 'Not signed in'}</CardTitle>
        {user?.email ? <KeyValue label="Email" value={user.email} /> : null}
        {status === 'signed_in' ? <Button label={busy === 'signout' ? 'Signing out…' : 'Sign out'} variant="secondary" onPress={() => void handleSignOut()} /> : null}
      </Card>

      <SectionTitle>Plan</SectionTitle>
      <Card>
        <CardTitle>{PLAN_TITLES}</CardTitle>
        <Body muted>Choose how much responsibility APM carries.</Body>
        <Button label="View plans" onPress={() => router.push('/settings/plan')} />
        <Button label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'} variant="secondary" onPress={() => void restore()} />
      </Card>

      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <CardTitle>Light or dark</CardTitle>
        <Muted>System follows your phone's setting.</Muted>
        <ChoiceRow<SchemePreference> options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} value={preference} onChange={setPreference} />
      </Card>

      <SectionTitle>Trust & control</SectionTitle>
      <ListRow icon="shield" title="Privacy & AI" detail="See your data, AI processing, providers, connections, permissions, activity and export." onPress={() => router.push('/settings/privacy')} />
      <ListRow icon="bell" title="Notifications" detail="Choose whether APM may reach this device. It stays rare: your morning agenda, real approvals and urgent Radar items." onPress={() => router.push('/settings/notifications')} />

      <SectionTitle>Life</SectionTitle>
      <ListRow icon="tool" title="Drafting Room" detail="Change your morning sequence, Hard/Guided start, pillars, floors, Tracks or Track settings without redoing the setup. Draft, review, then apply." onPress={() => router.push('/settings/os')} />
      <ListRow icon="edit-3" title="Diary" detail="File entries without coaching." onPress={() => router.push('/diary')} />
      <ListRow icon="bar-chart-2" title="Weekly debrief" detail="Review the week on your review day." onPress={() => router.push('/review')} />
      <ListRow icon="home" title="Life areas" detail="Relationships, birthdays, appointments, travel, bills, subscriptions, meals, shopping, health routines and recurring obligations." onPress={() => router.push('/settings/life')} />
      <ListRow icon="zap" title="Autopilot" detail="Standing rules you set for safe, reversible work, like scheduling routine blocks or preparing drafts. Revocable any time; never purchases, healthcare or money." onPress={() => router.push('/settings/autopilot')} />

      {status === 'signed_in' ? (
        <>
          <SectionTitle>Delete account</SectionTitle>
          <Card tone="danger">
            {!confirmDelete ? (
              <>
                <Body>Delete your account and everything APM holds about you. Connected calendars and email are disconnected too.</Body>
                <Button label="Delete my account" variant="danger" onPress={() => setConfirmDelete(true)} />
              </>
            ) : (
              <>
                <CardTitle>Delete everything? This cannot be undone.</CardTitle>
                <Body>Your account, your OS, your history and your connections are erased within 24 hours, and you are signed out now. A store subscription is cancelled in the App Store or Google Play, not here.</Body>
                <Button label={busy === 'delete' ? 'Deleting…' : 'Delete everything'} variant="danger" onPress={() => void deleteAccount()} />
                <Button label="Keep my account" variant="secondary" onPress={() => setConfirmDelete(false)} />
              </>
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
