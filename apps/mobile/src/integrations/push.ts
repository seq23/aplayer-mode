import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushToken, unregisterPushToken } from '../api/apmApi';

export async function enableApmPush(accessToken: string) {
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Notification permission was not granted');

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
