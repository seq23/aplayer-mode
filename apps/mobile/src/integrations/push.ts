import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { registerPushToken, unregisterPushToken } from '../api/apmApi';
import { PREVIEW, PREVIEW_COPY } from '../preview/flag';

/** She said no once: iOS never asks again, so only the phone's Settings can turn it back on. */
export class PushBlockedError extends Error {
  constructor() { super(PUSH_BLOCKED_COPY.body); this.name = 'PushBlockedError'; }
}

export const PUSH_BLOCKED_COPY = {
  title: 'Notifications are off for APM',
  body: 'Your phone is blocking them. Open Settings, tap Notifications, and switch them on for A Player Mode. Then come back.',
  action: 'Open Settings',
} as const;

/** 'blocked' = refused and the phone will not ask again (the system prompt never reappears). */
export async function pushPermissionState(): Promise<'granted' | 'blocked' | 'ask'> {
  if (PREVIEW || Platform.OS === 'web') return 'ask';
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'granted') return 'granted';
    return current.status === 'denied' && current.canAskAgain === false ? 'blocked' : current.status === 'denied' && Platform.OS === 'ios' ? 'blocked' : 'ask';
  } catch { return 'ask'; }
}

/** This app's page in the phone's Settings. */
export function openPhoneSettings(): void {
  void Linking.openSettings().catch(() => undefined);
}

export async function enableApmPush(accessToken: string) {
  // Free web preview: no browser permission prompt and no push token; say so and let her carry on.
  if (PREVIEW) throw new Error(PREVIEW_COPY.notifications);
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'denied' && (current.canAskAgain === false || Platform.OS === 'ios')) throw new PushBlockedError();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw permission.canAskAgain === false || Platform.OS === 'ios' ? new PushBlockedError() : new Error('Notification permission was not granted');

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('apm-attention', {
      name: 'APM attention',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.easConfig?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (!projectId) throw new Error('EAS project ID is not configured for push registration');
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

  await registerPushToken({
    expoPushToken: token,
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  }, accessToken);

  return token;
}

/**
 * Sign-out: stop this account's pushes on this device before the session ends, so the
 * next account on a shared phone never sees them. Best effort: never blocks sign-out.
 */
export async function disableApmPushForSignOut(accessToken: string): Promise<void> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.status !== 'granted') return;
    const projectId = Constants.easConfig?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await unregisterPushToken(token, accessToken);
  } catch {
    // The server also deactivates this token for the old account when the next one registers it.
  }
}
