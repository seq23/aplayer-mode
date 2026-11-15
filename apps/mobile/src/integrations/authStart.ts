/**
 * Web sign-in sheets (retest 14 Nov 2026). Pure helpers, no native imports, so tests can run them.
 *
 * 1. iOS names the domain of the FIRST URL an auth session opens ("APlayerMode Wants to Use …
 *    to Sign In"). A raw Supabase host looks untrustworthy, so a native app opens our own
 *    api.aplayermode.com/v1/auth/<provider>/start?to=<url>, which 302s to the same URL
 *    (services/api/src/authStart.ts checks it against an allow-list). The callback is unchanged.
 * 2. The button resets the moment the sheet comes back cancelled or dismissed, not after the
 *    rest of the sign-in call settles.
 */
export type AuthSheetProvider = 'google' | 'microsoft';

/** The address to open: our start URL on a native build returning to the app's own scheme; else the URL itself. */
export function authStartUrl(target: string, input: { provider: AuthSheetProvider; returnUrl: string; apiBase: string | undefined; platform: string }): string {
  const base = input.apiBase?.replace(/\/$/, '');
  // Web keeps its popup; a dev build (exp:// return) is not on the server's allow-list.
  if (input.platform === 'web' || !/^https:/.test(base ?? '') || !input.returnUrl.startsWith('aplayermode://')) return target;
  return `${base}/v1/auth/${input.provider}/start?to=${encodeURIComponent(target)}`;
}

export type AuthSheetResult = { type: string; url?: string };

/**
 * Opens the sheet and, when it comes back without a callback (cancel, dismiss, locked), calls
 * `onClosed` at once and returns null. A success returns the callback URL.
 */
export async function openAuthSheet(
  open: (url: string, returnUrl: string) => Promise<AuthSheetResult>,
  url: string,
  returnUrl: string,
  onClosed?: () => void,
): Promise<string | null> {
  const result = await open(url, returnUrl);
  if (result.type === 'success' && result.url) return result.url;
  onClosed?.();
  return null;
}
