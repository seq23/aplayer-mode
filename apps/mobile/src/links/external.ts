// The ONE way the app opens anything outside itself (App Review: website, Terms and
// Privacy open in the system browser, never an in-app webview shell). `npm run
// presubmit:ios` fails when an http(s) link or Linking.openURL appears anywhere else.
import { Linking } from 'react-native';

export type ExternalTarget =
  | { kind: 'web'; url: string }
  | { kind: 'call'; number: string }
  | { kind: 'text'; number: string };

/** Only https web links, and phone numbers made of digits. Anything else is refused. */
export function externalUrl(target: ExternalTarget): string | undefined {
  if (target.kind === 'web') return /^https:\/\/[^\s]+$/i.test(target.url) ? target.url : undefined;
  const digits = target.number.replace(/[^\d+]/g, '');
  if (!/^\+?\d{2,15}$/.test(digits)) return undefined;
  return target.kind === 'call' ? `tel:${digits}` : `sms:${digits}`;
}

/** Opens in the system browser / dialer / messages app (Safari or Chrome, never a webview). */
export async function openExternal(target: ExternalTarget): Promise<boolean> {
  const url = externalUrl(target);
  if (!url) return false;
  try { await Linking.openURL(url); return true; } catch { return false; }
}

/** The legal pages on the web app (the same pages ship in the build under /privacy and /terms). */
const WEB_APP = 'https://app.aplayermode.com';
export function legalPageUrl(page: 'privacy' | 'consumer-health'): string {
  const privacy = (process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || `${WEB_APP}/privacy`).replace(/\/+$/, '');
  return page === 'privacy' ? privacy : `${privacy}/consumer-health`;
}
