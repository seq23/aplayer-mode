import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';

export class SupabaseRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Supabase request failed with status ${status}`);
    this.name = 'SupabaseRestError';
  }
}

/**
 * Sentinel credential for the Cron Trigger only (services/api/src/morningTrigger.ts).
 * It resolves to the server-only SUPABASE_SECRET_KEY, which never reaches a client
 * and is never accepted from a request (auth.ts refuses this literal).
 */
export const SERVICE_ROLE_TOKEN = '__apm_service_role__';

export async function supabaseRest<T>(
  env: ApiEnv,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { url, publishableKey } = requireSupabaseConfig(env);
  const headers = new Headers(init.headers);
  if (accessToken === SERVICE_ROLE_TOKEN) {
    const secret = env.SUPABASE_SECRET_KEY;
    if (!secret) throw new Error('Supabase service credential is not configured');
    headers.set('apikey', secret);
    // Legacy service_role keys are JWTs and go in Authorization too; `sb_secret_` keys must not.
    if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
    else headers.delete('authorization');
  } else {
    headers.set('apikey', publishableKey);
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  headers.set('accept', 'application/json');

  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${url}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new SupabaseRestError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  // PostgREST answers `Prefer: return=minimal` writes with 201 and an EMPTY body;
  // parsing that as JSON would throw after the write already succeeded.
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}
