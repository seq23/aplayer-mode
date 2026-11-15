import type { ApiEnv } from './env';

/**
 * The first address a web sign-in opens (retest 14 Nov 2026). iOS names the domain of the FIRST
 * URL an auth session opens ("APlayerMode Wants to Use … to Sign In"), so the app opens
 * https://api.aplayermode.com/v1/auth/<provider>/start?to=<the URL it built before>, and this
 * Worker answers 302 to that URL. Nothing else changes: same redirect_to, same PKCE params, same
 * callback. It is never an open redirect: `to` must be one of the exact sign-in addresses below,
 * returning only to the app's own callback addresses.
 */
export type AuthStartProvider = 'google' | 'microsoft';
export const AUTH_START_PROVIDERS: readonly AuthStartProvider[] = ['google', 'microsoft'];

/** Where a sign-in may come back to: the app's own scheme only (query allowed, e.g. a PKCE flow id). */
export const AUTH_RETURN_ALLOWLIST = ['aplayermode://auth/callback', 'aplayermode://oauth'] as const;

/** Supabase authorize params the app sends today (supabase-js _getUrlForProvider). */
const SUPABASE_AUTHORIZE_PARAMS = new Set(['provider', 'redirect_to', 'code_challenge', 'code_challenge_method', 'scopes', 'skip_http_redirect']);
const MAX_TARGET_LENGTH = 4096;

function returnAllowed(value: string | null, env: ApiEnv): boolean {
  if (!value) return false;
  const base = value.split(/[?#]/)[0];
  const extra = [env.GOOGLE_OAUTH_REDIRECT_URI, env.MICROSOFT_OAUTH_REDIRECT_URI].filter((v): v is string => Boolean(v));
  return (AUTH_RETURN_ALLOWLIST as readonly string[]).includes(base) || extra.includes(value);
}

/** The URL to redirect to, or null when `to` is not an allowed sign-in address for `provider`. */
export function authStartTarget(env: ApiEnv, provider: string, to: string | undefined | null): string | null {
  if (!to || to.length > MAX_TARGET_LENGTH || !(AUTH_START_PROVIDERS as readonly string[]).includes(provider)) return null;
  let url: URL;
  try { url = new URL(to); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const q = url.searchParams;
  const supabaseOrigin = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin : null;

  // 1. Supabase sign-in (signInWithOAuth): our project only, provider matches, returns to the app.
  if (supabaseOrigin && url.origin === supabaseOrigin) {
    if (url.pathname !== '/auth/v1/authorize') return null;
    if (q.get('provider') !== provider || q.getAll('provider').length !== 1) return null;
    if ([...q.keys()].some((key) => !SUPABASE_AUTHORIZE_PARAMS.has(key))) return null;
    return returnAllowed(q.get('redirect_to'), env) ? url.toString() : null;
  }

  // 2. Google: Supabase's identity-link URL (comes back to our Supabase project, which checks
  //    its own redirect allow-list) or the calendar/email connector (our client id, app callback).
  if (provider === 'google' && url.origin === 'https://accounts.google.com' && ['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(url.pathname)) {
    const redirect = q.get('redirect_uri');
    if (supabaseOrigin && redirect === `${supabaseOrigin}/auth/v1/callback`) return url.toString();
    if (env.GOOGLE_OAUTH_CLIENT_ID && q.get('client_id') === env.GOOGLE_OAUTH_CLIENT_ID && returnAllowed(redirect, env)) return url.toString();
    return null;
  }

  // 3. Microsoft connector: our client id, app callback.
  if (provider === 'microsoft' && url.origin === 'https://login.microsoftonline.com' && /^\/[A-Za-z0-9.-]+\/oauth2\/v2\.0\/authorize$/.test(url.pathname)) {
    if (env.MICROSOFT_OAUTH_CLIENT_ID && q.get('client_id') === env.MICROSOFT_OAUTH_CLIENT_ID && returnAllowed(q.get('redirect_uri'), env)) return url.toString();
  }
  return null;
}
