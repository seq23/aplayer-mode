import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ApiEnv } from './env';

export interface AuthenticatedUser {
  id: string;
  claims: JWTPayload;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string) {
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

export async function authenticateRequest(
  request: Request,
  env: ApiEnv,
): Promise<AuthenticatedUser | null> {
  // Local-only escape hatch. Never configure this variable in staging/production.
  if (env.AUTH_DEV_BYPASS_USER_ID) {
    return {
      id: env.AUTH_DEV_BYPASS_USER_ID,
      claims: { sub: env.AUTH_DEV_BYPASS_USER_ID, apm_dev_bypass: true },
    };
  }

  if (!env.AUTH_JWKS_URL || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE) {
    throw new Error('Authentication provider is not configured');
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const result = await jwtVerify(token, getJwks(env.AUTH_JWKS_URL), {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
    });

    if (!result.payload.sub) return null;
    return { id: result.payload.sub, claims: result.payload };
  } catch {
    return null;
  }
}
