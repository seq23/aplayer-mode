export interface ApiEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  AUTH_DEV_BYPASS_USER_ID?: string;
  OPENROUTER_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

export function requireSupabaseConfig(env: ApiEnv): {
  url: string;
  publishableKey: string;
} {
  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error('Supabase is not configured');
  }

  return {
    url: url.replace(/\/$/, ''),
    publishableKey,
  };
}
