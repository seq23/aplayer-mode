import { Stack } from 'expo-router';
import { StatusBar } from 'react-native';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.ink,
          contentStyle: { backgroundColor: colors.background },
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
        <Stack.Screen name="privacy-primer" options={{ title: 'Privacy' }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
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
    </>
  );
}
