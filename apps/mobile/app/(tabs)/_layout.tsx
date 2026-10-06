import { Redirect, Tabs } from 'expo-router';
import { useSession } from '../../src/state/session';
import { colors } from '../../src/theme';

export default function TabsLayout() {
  const { status } = useSession();

  if (status === 'loading') return null;
  if (status !== 'signed_in') return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkMuted,
      }}
    >
      <Tabs.Screen name="today" options={{ title: 'TODAY' }} />
      <Tabs.Screen name="radar" options={{ title: 'RADAR' }} />
      <Tabs.Screen name="goals" options={{ title: 'GOALS' }} />
      <Tabs.Screen name="apm" options={{ title: 'APM' }} />
    </Tabs>
  );
}
