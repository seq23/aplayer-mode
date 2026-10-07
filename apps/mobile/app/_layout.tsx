import { Stack } from 'expo-router';
import { StatusBar } from 'react-native';
import { SessionProvider } from '../src/state/session';
import { LifeGraphProvider } from '../src/state/lifeGraph';
import { IntakeProvider } from '../src/intake/store';
import * as WebBrowser from 'expo-web-browser';

// Web: completes the Google sign-in popup (no-op on native).
WebBrowser.maybeCompleteAuthSession();
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <SessionProvider>
      <LifeGraphProvider>
        <IntakeProvider>
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
          {/* The one setup route: no header, no swipe-back; Android back is handled in-screen (docs/34 §6). */}
          <Stack.Screen name="intake" options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
          <Stack.Screen name="account" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
          <Stack.Screen name="settings/plan" options={{ title: 'Your plan' }} />
          <Stack.Screen name="settings/life" options={{ title: 'Life areas' }} />
          <Stack.Screen name="settings/autopilot" options={{ title: 'Autopilot' }} />
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
        </IntakeProvider>
      </LifeGraphProvider>
    </SessionProvider>
  );
}
