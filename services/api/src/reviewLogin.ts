import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { recordAudit } from './audit';

/**
 * App Review demo sign-in (docs/33 §8). Sign-in is a 6-digit email code, which a reviewer
 * cannot receive, so ONE reviewer account may sign in with a fixed code instead:
 *
 *   APP_REVIEW_EMAIL  the reviewer address (Worker var)
 *   APP_REVIEW_CODE   its fixed code, 6–12 digits (Worker secret)
 *
 * Off unless BOTH are set (and the server secret key exists): the route then answers 404
 * to everyone, exactly as for any address that is not the reviewer's, so it never reveals
 * which addresses have accounts. The code is accepted ONLY for that one address, compared
 * in constant time, and every sign-in is an `auth.review_login` audit row. Unset the two
 * values after review and the path is gone.
 */
export const REVIEW_CODE_PATTERN = /^\d{6,12}$/;

const encoder = new TextEncoder();
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(v)))));
  let diff = x!.length ^ y!.length;
  for (let i = 0; i < x!.length; i += 1) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

export function reviewLoginEnabled(env: ApiEnv): boolean {
  return Boolean(env.APP_REVIEW_EMAIL?.includes('@') && env.APP_REVIEW_CODE && REVIEW_CODE_PATTERN.test(env.APP_REVIEW_CODE) && env.SUPABASE_SECRET_KEY && env.SUPABASE_URL);
}

type Result = { status: 200 | 401 | 404 | 502; body: Record<string, unknown> };
const NOT_FOUND: Result = { status: 404, body: { error: 'not_found' } };

async function admin(env: ApiEnv, path: string, body: unknown): Promise<Response> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY!;
  const headers = new Headers({ apikey: secret, 'content-type': 'application/json' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  return fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function reviewLogin(env: ApiEnv, input: unknown): Promise<Result> {
  if (!reviewLoginEnabled(env)) return NOT_FOUND;
  const email = typeof (input as { email?: unknown })?.email === 'string' ? (input as { email: string }).email.trim().toLowerCase() : '';
  const code = (input as { code?: unknown })?.code;
  if (!email || !(await sameSecret(email, env.APP_REVIEW_EMAIL!.trim().toLowerCase()))) return NOT_FOUND;
  // Without a code: tell the app to skip sending an email (the reviewer types the fixed code).
  if (code === undefined) return { status: 200, body: { review: true } };
  if (typeof code !== 'string' || !(await sameSecret(code.trim(), env.APP_REVIEW_CODE!))) return { status: 401, body: { error: 'code_mismatch' } };

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
  return { status: 200, body: { review: true, session: { access_token: session.access_token, refresh_token: session.refresh_token } } };
}
