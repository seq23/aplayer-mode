import { useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, KeyValue, Screen, SectionTitle } from '../../src/components/ui';
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
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      {notice ? <Card tone="muted"><Body>{notice}</Body></Card> : null}

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

      <SectionTitle>Trust & control</SectionTitle>
      <Card>
        <CardTitle>Privacy & AI</CardTitle>
        <Body muted>See your data, AI processing, providers, connections, permissions, activity and export.</Body>
        <Button label="Open Privacy & AI" onPress={() => router.push('/settings/privacy')} />
      </Card>
      <Card>
        <CardTitle>Notifications</CardTitle>
        <Body muted>Choose whether APM may reach this device. It stays rare: your morning agenda, real approvals and urgent Radar items.</Body>
        <Button label="Notification settings" variant="secondary" onPress={() => router.push('/settings/notifications')} />
      </Card>

      <SectionTitle>Life</SectionTitle>
      <Card>
        <CardTitle>Drafting Room</CardTitle>
        <Body muted>Change your morning sequence, Hard/Guided start, pillars, floors, Tracks or Track settings without redoing the setup. Draft, review, then apply.</Body>
        <Button label="Open the Drafting Room" onPress={() => router.push('/settings/os')} />
      </Card>
      <Card>
        <CardTitle>Diary and weekly debrief</CardTitle>
        <Body muted>File entries without coaching; review the week on your review day.</Body>
        <Button label="Open the Diary" variant="secondary" onPress={() => router.push('/diary')} />
        <Button label="Weekly debrief" variant="secondary" onPress={() => router.push('/review')} />
      </Card>
      <Card>
        <CardTitle>Life areas</CardTitle>
        <Body muted>Relationships, birthdays, appointments, travel, bills, subscriptions, meals, shopping, health routines and recurring obligations.</Body>
        <Button label="Open life areas" onPress={() => router.push('/settings/life')} />
      </Card>
      <Card>
        <CardTitle>Autopilot</CardTitle>
        <Body muted>Standing rules you set for safe, reversible work, like scheduling routine blocks or preparing drafts. Revocable any time; never purchases, healthcare or money.</Body>
        <Button label="Open Autopilot" variant="secondary" onPress={() => router.push('/settings/autopilot')} />
      </Card>

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
