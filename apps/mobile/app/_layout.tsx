import { Stack } from 'expo-router';
import { StatusBar } from 'react-native';
import { SessionProvider } from '../src/state/session';
import { LifeGraphProvider } from '../src/state/lifeGraph';
import { IntakeProvider } from '../src/intake/store';
import { ConsentProvider } from '../src/state/consent';
import { ConsentGate } from '../src/components/consent/ConsentViews';
import { AccountMenu } from '../src/components/AccountMenu';
import * as WebBrowser from 'expo-web-browser';

// Web: completes the Google sign-in popup (no-op on native).
WebBrowser.maybeCompleteAuthSession();
import { ThemeProvider, useTheme } from '../src/theme';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <LifeGraphProvider>
          <IntakeProvider>
            <ConsentProvider>
              <ThemedStack />
            </ConsentProvider>
          </IntakeProvider>
        </LifeGraphProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

/** The navigator in the current scheme: Stone header and content, Ink title in Outfit, no shadow. */
function ThemedStack() {
  const { colors, scheme, type } = useTheme();
  const { maxFontSizeMultiplier: _scale, ...titleFont } = type.cardTitle;
  return (
    <>
        <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
        <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerTintColor: colors.ink,
            headerStyle: { backgroundColor: colors.bg },
            headerTitleStyle: { ...titleFont, color: colors.ink },
            contentStyle: { backgroundColor: colors.bg },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          {/* 18+ and the health-data choice come before the setup questions (server migration 0093). */}
          <Stack.Screen name="age" options={{ headerShown: false }} />
          <Stack.Screen name="join" options={{ headerShown: false }} />
          <Stack.Screen name="health-consent" options={{ headerShown: false }} />
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
          <Stack.Screen name="settings/privacy/health-data" options={{ title: 'Consumer health data' }} />
          <Stack.Screen name="radar/why" options={{ title: 'Why APM saw this' }} />
          {/* Every pushed route has a human title (an unregistered route shows its file name). */}
          <Stack.Screen name="diary" options={{ title: 'Diary' }} />
          <Stack.Screen name="billing/return" options={{ title: 'Your plan' }} />
          <Stack.Screen name="review" options={{ title: 'Weekly debrief' }} />
          <Stack.Screen name="settings/os" options={{ title: 'Drafting Room' }} />
        </Stack>
        {/* Top right of every signed-in page: email, plan, Sign out. Under the consent screens. */}
        <AccountMenu />
        <ConsentGate />
    </>
  );
}
