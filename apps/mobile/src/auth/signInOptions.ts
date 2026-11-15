// Which "Continue with …" sign-in buttons the app shows, and the plain words for an auth failure.
// Pure (no React Native imports) so the tests can load it directly.

/**
 * Google sign-in is hidden until the Google provider is switched on in the Supabase project
 * (owner call 14 Nov 2026: Apple on, Google hidden). The code path stays; turning it back on is
 * this one line. This is account sign-in only: the Google calendar/email *connect* buttons in
 * Settings go through APM's own OAuth (src/integrations/oauth.ts), not Supabase's provider.
 */
export const GOOGLE_SIGN_IN_ENABLED = false;

export type SignInOption = 'apple' | 'google' | 'email';

/** The buttons on every account panel (sign-in, welcome back, save your plan), in order. */
export function signInOptions(platform: string, googleEnabled: boolean = GOOGLE_SIGN_IN_ENABLED): SignInOption[] {
  return [
    ...(platform === 'ios' ? (['apple'] as const) : []),
    ...(googleEnabled ? (['google'] as const) : []),
    'email',
  ];
}

const PROVIDER_NAME: Record<'apple' | 'google', string> = { apple: 'Apple', google: 'Google' };

/** Supabase answers "Unsupported provider: provider is not enabled" (code provider_disabled). */
function providerNotEnabled(error: unknown): boolean {
  const { message = '', code = '' } = (error && typeof error === 'object' ? error : { message: String(error ?? '') }) as { message?: string; code?: string };
  return code === 'provider_disabled' || /provider is not enabled|unsupported provider/i.test(message);
}

/** Plain errors only: no vendor names, no codes (detail goes to logs). */
export function friendlyAuthError(error: unknown, provider?: 'apple' | 'google'): string {
  if (providerNotEnabled(error)) {
    return provider ? `${PROVIDER_NAME[provider]} sign-in isn't available yet. Use your email instead.` : 'That sign-in isn\'t available yet. Use your email instead.';
  }
  const message = error instanceof Error ? error.message : String((error as { message?: string } | null)?.message ?? error ?? '');
  if (/token.*(expired|invalid)|otp|code/i.test(message)) return 'That code didn\'t match. Try again or resend.';
  if (/rate|too many/i.test(message)) return 'Too many tries. Wait a minute and try again.';
  if (/network|fetch/i.test(message)) return 'You seem to be offline. Your answers are saved on this phone.';
  if (/configuration|not configured/i.test(message)) return 'Setup isn\'t finished on this build.';
  return 'That didn\'t work. Try again, or use another way to save.';
}
