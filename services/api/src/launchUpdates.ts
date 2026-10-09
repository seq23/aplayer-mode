import type { ApiEnv } from './env';
import { serviceRpc } from './db';

/**
 * "Get launch updates" on aplayermode.com (owner, 8 Oct 2026; migration 0095). No account and no
 * session: an email and an explicit consent tick. The wording and version stored are THIS copy,
 * never text the browser sent; the landing page shows the same words (sprylabs-hpc-site
 * aplayermode/index.html, pinned by its validator). Nothing sends email from this list yet.
 */
export const LAUNCH_UPDATES_CONSENT = {
  version: '2026-10-08',
  text: 'Email me A Player Mode launch updates. No spam; unsubscribe any time. Spry Labs handles your email under the Privacy Policy at app.aplayermode.com/privacy.',
} as const;

/** The only page allowed to call the route from a browser. */
export const LAUNCH_UPDATES_ORIGINS: ReadonlySet<string> = new Set(['https://aplayermode.com']);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
type Result = { status: 200 | 400 | 409 | 429 | 503; body: Record<string, unknown> };

/** Validates and stores one sign-up; the same answer for a new and a repeated address. */
export async function launchUpdatesSignup(env: ApiEnv, input: unknown, allowed: () => Promise<boolean>): Promise<Result> {
  const body = (input ?? {}) as { email?: unknown; consent?: unknown; consentVersion?: unknown; website?: unknown };
  // Honeypot: a hidden field people never fill. Bots get the normal answer and nothing is stored.
  if (typeof body.website === 'string' && body.website.trim() !== '') return { status: 200, body: { ok: true } };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) return { status: 400, body: { error: 'invalid_email', message: 'Enter a full email address.' } };
  if (body.consent !== true) return { status: 400, body: { error: 'consent_required', message: 'Tick the box to agree to launch-update emails.' } };
  if (body.consentVersion !== LAUNCH_UPDATES_CONSENT.version) return { status: 409, body: { error: 'consent_outdated', message: 'The wording changed. Reload the page and try again.' } };
  if (!env.SUPABASE_SECRET_KEY) return { status: 503, body: { error: 'not_configured' } };
  if (!(await allowed())) return { status: 429, body: { error: 'rate_limited', message: 'Too many tries. Wait a minute.' } };
  await serviceRpc(env, 'apm_service_launch_signup', { p_email: email, p_source: 'aplayermode.com', p_consent_text: LAUNCH_UPDATES_CONSENT.text, p_consent_version: LAUNCH_UPDATES_CONSENT.version });
  return { status: 200, body: { ok: true } };
}
