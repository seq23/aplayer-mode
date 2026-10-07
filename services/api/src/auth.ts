import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { SERVICE_ROLE_TOKEN } from './db';

export interface AuthenticatedUser {
  id: string;
  accessToken: string;
  email?: string;
  /** A Supabase anonymous session (the intake before an account exists). */
  isAnonymous?: boolean;
}

declare const __APM_RUNTIME_ENVIRONMENT__: string | undefined;

/** 'staging' / 'production' on a deployed Worker (Wrangler define); 'development' locally. */
export function runtimeEnvironment(): string {
  return typeof __APM_RUNTIME_ENVIRONMENT__ === 'string' ? __APM_RUNTIME_ENVIRONMENT__ : 'development';
}

/** True when the dev bypass variable is set on a deployed Worker: a named misconfiguration. */
export function devBypassMisconfigured(env: ApiEnv): boolean {
  return Boolean(env.AUTH_DEV_BYPASS_USER_ID) && runtimeEnvironment() !== 'development';
}

export async function authenticateRequest(
  request: Request,
  env: ApiEnv,
): Promise<AuthenticatedUser | null> {
  // Local-only escape hatch, enforced in code: it is ignored on any deployed Worker
  // (staging/production), and /v1/health fails while it is set there.
  if (env.AUTH_DEV_BYPASS_USER_ID && runtimeEnvironment() === 'development') {
    return {
      id: env.AUTH_DEV_BYPASS_USER_ID,
      accessToken: 'apm-dev-bypass',
    };
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const accessToken = header.slice('Bearer '.length).trim();
  if (!accessToken || accessToken === SERVICE_ROLE_TOKEN) return null;

  const { url, publishableKey } = requireSupabaseConfig(env);
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string; email?: string; is_anonymous?: boolean };
  if (!user.id) return null;

  return {
    id: user.id,
    accessToken,
    email: user.email,
    isAnonymous: user.is_anonymous === true,
  };
}

/** Verifies a second access token (the anonymous session being merged into an account). */
export async function verifyAccessToken(token: string, env: ApiEnv): Promise<AuthenticatedUser | null> {
  if (!token || env.AUTH_DEV_BYPASS_USER_ID) return null;
  return authenticateRequest(new Request('https://apm.invalid/', { headers: { authorization: `Bearer ${token}` } }), { ...env, AUTH_DEV_BYPASS_USER_ID: undefined });
}
