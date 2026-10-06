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
    </Screen>
  );
}
