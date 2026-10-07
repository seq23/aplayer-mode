import { Redirect, Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../../src/state/session';
import { TabIcon, type IconName } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

/** One icon set (Feather) for the tab bar. */
const TAB_ICONS: Record<string, IconName> = { today: 'sun', radar: 'compass', goals: 'target', apm: 'message-circle' };

export default function TabsLayout() {
  const { status } = useSession();
  const { colors, type } = useTheme();
  const insets = useSafeAreaInsets();

  if (status === 'loading') return null;
  if (status !== 'signed_in') return <Redirect href="/welcome" />;
  const { maxFontSizeMultiplier: _scale, ...labelFont } = type.tab;

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkMuted,
        // Room for the icon pill and a label with descenders, above the home indicator.
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line, height: 62 + insets.bottom, paddingTop: 6 },
        tabBarLabelStyle: labelFont,
        tabBarIcon: ({ focused }) => <TabIcon icon={TAB_ICONS[route.name] ?? 'circle'} focused={focused} />,
        sceneStyle: { backgroundColor: colors.bg },
      })}
    >
      <Tabs.Screen name="today" options={{ title: 'Today', tabBarAccessibilityLabel: 'Today' }} />
      <Tabs.Screen name="radar" options={{ title: 'Radar', tabBarAccessibilityLabel: 'Radar' }} />
      <Tabs.Screen name="goals" options={{ title: 'Goals', tabBarAccessibilityLabel: 'Goals' }} />
      <Tabs.Screen name="apm" options={{ title: 'Coach', tabBarAccessibilityLabel: 'Coach' }} />
    </Tabs>
  );
}
