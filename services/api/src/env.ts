export interface HyperdriveBinding {
  connectionString: string;
}

export interface ApiEnv {
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
  AUTH_JWKS_URL?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_DEV_BYPASS_USER_ID?: string;
  OPENROUTER_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

export function requireDatabaseConnectionString(env: ApiEnv): string {
  const value = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!value) throw new Error('Database is not configured');
  return value;
}
