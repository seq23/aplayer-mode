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
import { WEB_CHECKOUT_COPY } from '../../src/billing/webCheckout';

/** Her plan by its ONE display name (ADR-0006); never retyped here. */
const PAID_KEYS = ['chief_of_staff', 'life_os', 'autopilot'] as const;
function planTitle(plan: string | undefined, usable: boolean): string {
  if (!usable || !plan || !(PAID_KEYS as readonly string[]).includes(plan)) return 'No plan yet';
  return PLAN_PRICES[plan as (typeof PAID_KEYS)[number]].displayName;
}

export default function SettingsScreen() {
  const { user, status, accessToken, signOut } = useSession();
  const { refresh, graph } = useLifeGraph();
  const entitlement = graph.entitlement;
  const usable = entitlement?.status === 'active' || entitlement?.status === 'trialing';
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
    // Web / sideload: card subscriptions follow the account; there is no store to restore from.
    if (!availability.available) { setNotice(availability.reason === 'web' || availability.reason === 'sideload' ? WEB_CHECKOUT_COPY.restore : UNAVAILABLE_COPY[availability.reason]); return; }
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
    <Screen title="Your A Player Mode." subtitle="What APM knows, what it may do, and your plan.">
      {error ? <ErrorState message={error} /> : null}
      <Toast message={notice} />

      {status !== 'signed_in' ? (
        <Card tone="warning">
          <CardTitle>You are not signed in</CardTitle>
          <Body muted>Sign in to see your plan, your data and your settings.</Body>
          <Button label="Sign in" onPress={() => router.push('/account')} />
        </Card>
      ) : null}

      <SectionTitle>Your plan</SectionTitle>
      <Card>
        <CardTitle>{planTitle(entitlement?.plan, usable)}</CardTitle>
        <Body muted>{usable ? 'Change how much APM carries, or manage your subscription.' : 'Pick how much APM carries for you.'}</Body>
        <Button label={usable ? 'Change plan' : 'See plans'} onPress={() => router.push('/settings/plan')} />
        <Button label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'} variant="secondary" busy={busy === 'restore'} onPress={() => restore()} />
      </Card>

      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <CardTitle>Light or dark</CardTitle>
        <Muted>System follows your phone's setting.</Muted>
        <ChoiceRow<SchemePreference> options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} value={preference} onChange={setPreference} />
      </Card>

      <SectionTitle>Trust & control</SectionTitle>
      <ListRow icon="shield" title="Privacy & AI" detail="What APM knows, how AI is used, export or delete." onPress={() => router.push('/settings/privacy')} />
      <ListRow icon="bell" title="Notifications" detail="Your morning plan, approvals and urgent heads-ups. Nothing else." onPress={() => router.push('/settings/notifications')} />

      <SectionTitle>Life</SectionTitle>
      <ListRow icon="tool" title="Drafting Room" detail="Change your morning, rules or Tracks without redoing setup." onPress={() => router.push('/settings/os')} />
      <ListRow icon="edit-3" title="Diary" detail="Jot something down. No coaching." onPress={() => router.push('/diary')} />
      <ListRow icon="bar-chart-2" title="Weekly debrief" detail="A five-minute look back at your week." onPress={() => router.push('/review')} />
      <ListRow icon="home" title="Life areas" detail="Birthdays, bills, appointments and the rest of life admin." onPress={() => router.push('/settings/life')} />
      <ListRow icon="zap" title="Autopilot" detail="Routine work APM may do inside rules you set. Never money or health." onPress={() => router.push('/settings/autopilot')} />

      {status === 'signed_in' ? (
        <>
          <SectionTitle>Account</SectionTitle>
          <Card>
            {user?.email ? <KeyValue label="Signed in as" value={user.email} /> : <CardTitle>Signed in</CardTitle>}
            <Button label={busy === 'signout' ? 'Signing out…' : 'Sign out'} variant="secondary" busy={busy === 'signout'} onPress={() => handleSignOut()} />
          </Card>
        </>
      ) : null}

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
