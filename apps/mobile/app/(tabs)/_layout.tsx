import { Tabs } from 'expo-router';
import { colors } from '../../src/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '800',
          letterSpacing: 0.5,
        },
      }}
    >
      <Tabs.Screen name="today" options={{ title: 'TODAY' }} />
      <Tabs.Screen name="radar" options={{ title: 'RADAR' }} />
      <Tabs.Screen name="goals" options={{ title: 'GOALS' }} />
      <Tabs.Screen name="apm" options={{ title: 'APM' }} />
    </Tabs>
  );
}
