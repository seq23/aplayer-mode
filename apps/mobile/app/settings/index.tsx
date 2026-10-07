import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, KeyValue, Screen, SectionTitle } from '../../src/components/ui';
import { useSession } from '../../src/state/session';

export default function SettingsScreen() {
  const { user, status, signOut } = useSession();

  const handleSignOut = async () => {
    await signOut();
    router.replace('/welcome');
  };

  return (
    <Screen eyebrow="Settings" title="Your A Player Mode." subtitle="Control how APM understands, connects and acts.">
      <SectionTitle>Account</SectionTitle>
      <Card>
        <CardTitle>{status === 'signed_in' ? 'Private APM account' : 'Not signed in'}</CardTitle>
        {user?.email ? <KeyValue label="Email" value={user.email} /> : null}
        {status === 'signed_in' ? <Button label="Sign out" variant="secondary" onPress={() => void handleSignOut()} /> : null}
      </Card>

      <SectionTitle>Plan</SectionTitle>
      <Card>
        <CardTitle>Chief of Staff · Life OS · Autopilot</CardTitle>
        <Body muted>Choose how much responsibility APM carries. Household OS is later and has an interest list instead of access.</Body>
        <Button label="View plans" onPress={() => router.push('/settings/plan')} />
      </Card>

      <SectionTitle>Trust & control</SectionTitle>
      <Card>
        <CardTitle>Privacy & AI</CardTitle>
        <Body muted>See your data, AI processing, providers, connections, permissions, activity, export and deletion.</Body>
        <Button label="Open Privacy & AI" onPress={() => router.push('/settings/privacy')} />
      </Card>
      <Card>
        <CardTitle>Notifications</CardTitle>
        <Body muted>Choose whether proactive APM may reach this device. Server-side suppression keeps notifications rare and consequential.</Body>
        <Button label="Notification settings" variant="secondary" onPress={() => router.push('/settings/notifications')} />
      </Card>

      <SectionTitle>Life</SectionTitle>
      <Card>
        <CardTitle>Your operating system</CardTitle>
        <Body muted>Identity, roles, goals, projects, routines, people, preferences, rules and current season are stored in your Life Graph and surfaced through Today, Goals and Privacy & AI.</Body>
      </Card>
      <Card>
        <CardTitle>Drafting Room</CardTitle>
        <Body muted>Change your morning sequence, Hard/Guided start, pillars, floors, Tracks or Track settings without redoing the intake. Draft, review, then apply.</Body>
        <Button label="Open the Drafting Room" onPress={() => router.push('/settings/os')} />
      </Card>
      <Card>
        <CardTitle>Diary and weekly debrief</CardTitle>
        <Body muted>File entries without coaching; review the week every review day.</Body>
        <Button label="Open the Diary" variant="secondary" onPress={() => router.push('/diary')} />
        <Button label="Weekly debrief" variant="secondary" onPress={() => router.push('/review')} />
      </Card>
      <Card>
        <CardTitle>Life OS</CardTitle>
        <Body muted>Relationships, birthdays, appointments, travel, bills, subscriptions, meals, shopping, health routines and recurring obligations—managed in the same private Life Graph.</Body>
        <Button label="Open Life OS" onPress={() => router.push('/settings/life')} />
      </Card>
      <Card>
        <CardTitle>Autopilot</CardTitle>
        <Body muted>Standing rules you set for safe, reversible work—like scheduling routine blocks or preparing drafts. Revocable any time; never purchases, healthcare or money.</Body>
        <Button label="Open Autopilot" variant="secondary" onPress={() => router.push('/settings/autopilot')} />
      </Card>
    </Screen>
  );
}
