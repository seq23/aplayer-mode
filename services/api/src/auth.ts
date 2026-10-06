import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';

export interface AuthenticatedUser {
  id: string;
  accessToken: string;
  email?: string;
}

export async function authenticateRequest(
  request: Request,
  env: ApiEnv,
): Promise<AuthenticatedUser | null> {
  // Local-only escape hatch. Never configure this variable in staging/production.
  if (env.AUTH_DEV_BYPASS_USER_ID) {
    return {
      id: env.AUTH_DEV_BYPASS_USER_ID,
      accessToken: 'apm-dev-bypass',
    };
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const accessToken = header.slice('Bearer '.length).trim();
  if (!accessToken) return null;

  const { url, publishableKey } = requireSupabaseConfig(env);
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string; email?: string };
  if (!user.id) return null;

  return {
    id: user.id,
    accessToken,
    email: user.email,
  };
}
