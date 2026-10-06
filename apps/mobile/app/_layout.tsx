import { Stack } from 'expo-router';
import { StatusBar } from 'react-native';
import { SessionProvider } from '../src/state/session';
import { LifeGraphProvider } from '../src/state/lifeGraph';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <SessionProvider>
      <LifeGraphProvider>
        <StatusBar barStyle="dark-content" />
        <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerTintColor: colors.ink,
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          <Stack.Screen name="privacy-primer" options={{ title: 'Privacy' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Your APM account' }} />
          <Stack.Screen name="onboarding" options={{ title: 'Build your APM' }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
          <Stack.Screen name="settings/plan" options={{ title: 'Your plan' }} />
          <Stack.Screen name="settings/life" options={{ title: 'Life OS' }} />
          <Stack.Screen name="settings/notifications" options={{ title: 'Notifications' }} />
          <Stack.Screen name="settings/privacy/index" options={{ title: 'Privacy & AI' }} />
          <Stack.Screen name="settings/privacy/how-ai-works" options={{ title: 'How APM Uses AI' }} />
          <Stack.Screen name="settings/privacy/providers" options={{ title: 'AI Providers' }} />
          <Stack.Screen name="settings/privacy/data" options={{ title: 'Your Data' }} />
          <Stack.Screen name="settings/privacy/connections" options={{ title: 'Connections' }} />
          <Stack.Screen name="settings/privacy/autonomy" options={{ title: 'Permissions & Autonomy' }} />
          <Stack.Screen name="settings/privacy/activity" options={{ title: 'APM Activity' }} />
          <Stack.Screen name="settings/privacy/export-delete" options={{ title: 'Export & Delete' }} />
          <Stack.Screen name="radar/why" options={{ title: 'Why APM saw this' }} />
        </Stack>
      </LifeGraphProvider>
    </SessionProvider>
  );
}
