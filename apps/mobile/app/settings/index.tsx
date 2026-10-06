import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, KeyValue, Screen, SectionTitle } from '../../src/components/ui';
import { useSession } from '../../src/state/session';

export default function SettingsScreen() {
  const { user, signOut } = useSession();

  const handleSignOut = async () => {
    await signOut();
    router.replace('/welcome');
  };

  return (
    <Screen
      eyebrow="Settings"
      title="Your A Player Mode."
      subtitle="Control how APM understands, connects and acts."
    >
      <SectionTitle>Account</SectionTitle>
      <Card>
        <CardTitle>Your private APM account</CardTitle>
        <KeyValue label="Signed in as" value={user?.email ?? 'Authenticated user'} />
        <Button label="Sign out" variant="secondary" onPress={() => void handleSignOut()} />
      </Card>

      <SectionTitle>Trust & control</SectionTitle>
      <Card>
        <CardTitle>Privacy & AI</CardTitle>
        <Body muted>See your data, AI processing, providers, connections, permissions, activity, export and deletion.</Body>
        <Button label="Open Privacy & AI" onPress={() => router.push('/settings/privacy')} />
      </Card>

      <SectionTitle>Coming next</SectionTitle>
      <Card>
        <CardTitle>Life</CardTitle>
        <Body muted>Identity, roles, goals, projects, routines, people, preferences and operating rules.</Body>
      </Card>
      <Card>
        <CardTitle>Notifications</CardTitle>
        <Body muted>Control when proactive APM notifications may interrupt you and how much appears on the lock screen.</Body>
      </Card>
    </Screen>
  );
}
