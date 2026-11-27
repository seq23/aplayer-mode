import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { recordAudit } from './audit';
import { serviceRpc } from './db';
import { REVIEW_CODE_PATTERN } from '@apm/policy';

/**
 * App Review demo sign-in (docs/33 §8). Sign-in is a 6-digit email code, which a reviewer
 * cannot receive, so ONE reviewer account may sign in with a fixed code instead:
 *
 *   APP_REVIEW_EMAIL  the reviewer address (Worker var)
 *   APP_REVIEW_CODE   its fixed code (Worker secret): 6 digits, or 12–24 letters and digits
 *                     (REVIEW_CODE_PATTERN in @apm/policy, the same rule as the app's code box)
 *   APP_REVIEW_UNTIL  optional: the moment the review window closes (Worker var, an ISO date or
 *                     date-time). Not set = no end date. Set and passed, or set and unreadable =
 *                     off, exactly as if the code were unset.
 *
 * Off unless BOTH are set (and the server secret key exists): the route then answers 404
 * to everyone, exactly as for any address that is not the reviewer's, so it never reveals
 * which addresses have accounts. The code is accepted ONLY for that one address, compared
 * in constant time, and every sign-in is an `auth.review_login` audit row. Delete the code
 * after the review (RUNBOOK "Store review sign-in") and the path is gone.
 *
 * A 6-digit code is guessable, so every code presented for the reviewer address takes a try
 * in the database BEFORE it is compared (migration 0108; one count for every Cloudflare
 * location): REVIEW_LOGIN_LIMITS.devicePerDay wrong codes per device per UTC day, then that
 * device is locked until the day ends (429), and globalPerDay wrong codes from everyone
 * together (429). A locked device never touches the shared count, so one stranger can use at
 * most devicePerDay of it and cannot lock out the reviewer's device. The right code gives its
 * try back. A count that cannot be taken refuses the sign-in (503): never a session.
 */
/**
 * globalPerDay bounds a guesser with many addresses to 500 of the 1,000,000 six-digit codes a day
 * (0.05%) and takes 50 separate networks at full lockout to spend. A 16-character code (62^16
 * choices) is out of reach at 500 a day; the RUNBOOK sets one before each store review.
 */
export const REVIEW_LOGIN_LIMITS = { devicePerDay: 10, globalPerDay: 500 } as const;

// One rule with the app's code box (@apm/policy): 6 digits, or 12–24 letters and digits. A code of
// any other shape keeps the route off, because no store build could type it (16 Nov 2026: an
// 8-digit code passed the old check but the 6-digit box could not hold it).
export { REVIEW_CODE_PATTERN };

const encoder = new TextEncoder();
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(v)))));
  let diff = x!.length ^ y!.length;
  for (let i = 0; i < x!.length; i += 1) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

/** No APP_REVIEW_UNTIL = no end date. A value that is not a date closes the window: a typo never means "open for good". */
function reviewWindowOpen(env: ApiEnv, nowMs: number): boolean {
  const raw = env.APP_REVIEW_UNTIL?.trim();
  if (!raw) return true;
  const until = Date.parse(raw);
  return Number.isFinite(until) && until > nowMs;
}

export function reviewLoginEnabled(env: ApiEnv, nowMs: number = Date.now()): boolean {
  return Boolean(env.APP_REVIEW_EMAIL?.includes('@') && env.APP_REVIEW_CODE && REVIEW_CODE_PATTERN.test(env.APP_REVIEW_CODE) && env.SUPABASE_SECRET_KEY && env.SUPABASE_URL)
    && reviewWindowOpen(env, nowMs);
}

/** IPv6 is cut to its /64: one home or phone holds a whole /64, so the full address would give one guesser 2^64 "devices". */
export function devicePrefix(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => (parseInt(group || '0', 16) || 0).toString(16)).join(':')}::/64`;
}

/** What the try counter stores for a caller: HMAC-SHA256 keyed with the server secret, never the address itself. */
async function deviceKey(env: ApiEnv, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.SUPABASE_SECRET_KEY!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`review-login|${devicePrefix(ip)}`)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Result = { status: 200 | 401 | 404 | 429 | 502 | 503; body: Record<string, unknown> };
const NOT_FOUND: Result = { status: 404, body: { error: 'not_found' } };

async function admin(env: ApiEnv, path: string, body: unknown): Promise<Response> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY!;
  const headers = new Headers({ apikey: secret, 'content-type': 'application/json' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  return fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** `ip` is the caller's network address as Cloudflare saw it (cf-connecting-ip), never a header the caller can set. */
export async function reviewLogin(env: ApiEnv, input: unknown, caller: { ip: string; nowMs?: number }): Promise<Result> {
  if (!reviewLoginEnabled(env, caller.nowMs ?? Date.now())) return NOT_FOUND;
  const email = typeof (input as { email?: unknown })?.email === 'string' ? (input as { email: string }).email.trim().toLowerCase() : '';
  const code = (input as { code?: unknown })?.code;
  if (!email || !(await sameSecret(email, env.APP_REVIEW_EMAIL!.trim().toLowerCase()))) return NOT_FOUND;
  // Without a code: tell the app to skip sending an email (the reviewer types the fixed code).
  if (code === undefined) return { status: 200, body: { review: true } };
  if (typeof code !== 'string') return { status: 401, body: { error: 'code_mismatch' } };

  // Every code presented costs a try, taken before the compare, whatever the code is.
  let device: string; let verdict: unknown;
  try {
    device = await deviceKey(env, caller.ip);
    verdict = await serviceRpc(env, 'apm_service_review_login_try', { p_device: device, p_device_cap: REVIEW_LOGIN_LIMITS.devicePerDay, p_global_cap: REVIEW_LOGIN_LIMITS.globalPerDay });
  } catch {
    console.error('NAMED STOP [REVIEW_LOGIN_TRIES_UNAVAILABLE] the try counter (migration 0108) could not be reached; review sign-in refused');
    return { status: 503, body: { error: 'review_login_unavailable' } };
  }
  if (verdict === 'device_locked') return { status: 429, body: { error: 'too_many_tries', message: 'Too many wrong codes from this device today. Try again after 00:00 UTC.' } };
  if (verdict === 'global_locked') {
    console.error('NAMED STOP [REVIEW_LOGIN_DAILY_CEILING] wrong review codes reached the daily ceiling; review sign-in is paused until 00:00 UTC');
    return { status: 429, body: { error: 'review_login_paused', message: 'Review sign-in is paused for today. Try again after 00:00 UTC.' } };
  }
  // Anything but a plain "ok" is an answer this code does not know: refused, never let through.
  if (verdict !== 'ok') {
    console.error('NAMED STOP [REVIEW_LOGIN_TRIES_UNAVAILABLE] the try counter gave an unknown answer; review sign-in refused');
    return { status: 503, body: { error: 'review_login_unavailable' } };
  }
  if (!(await sameSecret(code.trim(), env.APP_REVIEW_CODE!))) return { status: 401, body: { error: 'code_mismatch' } };
  // The right code gives its try back, so the reviewer's own sign-ins never use up a budget.
  try {
    await serviceRpc(env, 'apm_service_review_login_release', { p_device: device });
  } catch {
    console.warn('NAMED STOP [REVIEW_LOGIN_RELEASE_FAILED] a right code kept its try for today');
  }

  // The account exists from the first review sign-in on (422 = already there).
  const created = await admin(env, '/auth/v1/admin/users', { email, email_confirm: true });
  if (!created.ok && created.status !== 422 && created.status !== 400) return { status: 502, body: { error: 'review_login_unavailable' } };
  // A one-time login token for THIS address, exchanged for a session right here.
  const link = await admin(env, '/auth/v1/admin/generate_link', { type: 'magiclink', email });
  if (!link.ok) return { status: 502, body: { error: 'review_login_unavailable' } };
  const linkBody = await link.json() as { hashed_token?: string; properties?: { hashed_token?: string } };
  const tokenHash = linkBody.hashed_token ?? linkBody.properties?.hashed_token;
  if (!tokenHash) return { status: 502, body: { error: 'review_login_unavailable' } };
  const { url, publishableKey } = requireSupabaseConfig(env);
  const verified = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!verified.ok) return { status: 502, body: { error: 'review_login_unavailable' } };
  const session = await verified.json() as { access_token?: string; refresh_token?: string; user?: { id?: string } };
  if (!session.access_token || !session.refresh_token || !session.user?.id) return { status: 502, body: { error: 'review_login_unavailable' } };
  await recordAudit(env, session.user.id, { actor: 'user', type: 'auth.review_login' }, { method: 'fixed_code' }, 'auth_user', session.user.id);
  // App Review reaches Executive Suite and Autopilot with labelled sample Life-areas items
  // (migration 0105). A failure never blocks the sign-in; it is a named stop someone sees.
  try {
    await serviceRpc(env, 'apm_service_review_account_prepare', { p_user_id: session.user.id });
  } catch {
    console.warn('NAMED STOP [REVIEW_ACCOUNT_PREPARE_FAILED]');
  }
  return { status: 200, body: { review: true, session: { access_token: session.access_token, refresh_token: session.refresh_token } } };
}
