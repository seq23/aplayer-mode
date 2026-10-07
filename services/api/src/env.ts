export interface ApiEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** Server-only Supabase secret key: agenda-locking writes (0028) and the scheduled Morning Trigger. Never in the mobile bundle. */
  SUPABASE_SECRET_KEY?: string;
  AUTH_DEV_BYPASS_USER_ID?: string;
  OPENROUTER_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
  APP_PUBLIC_URL?: string;
  CONNECTOR_CREDENTIAL_KEY?: string;
  OAUTH_STATE_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  MICROSOFT_OAUTH_CLIENT_ID?: string;
  MICROSOFT_OAUTH_CLIENT_SECRET?: string;
  MICROSOFT_OAUTH_REDIRECT_URI?: string;
  MICROSOFT_TENANT?: string;
  EXPO_ACCESS_TOKEN?: string;
  GLOBAL_ACTION_EXECUTION?: string;
  ACTION_CALENDAR_EXECUTION?: string;
  ACTION_EMAIL_EXECUTION?: string;
  /** Phase C kill switch for standing (level-5) execution. Off unless exactly 'true'. */
  AUTOPILOT_EXECUTION?: string;
  /**
   * Per-class Autopilot switch: comma-separated class keys allowed to run (e.g.
   * `calendar.create,email.draft`). A class not listed never runs, whatever its
   * database activation says. Empty/absent = none.
   */
  AUTOPILOT_ENABLED_CLASSES?: string;
  /**
   * Phase D: the value RevenueCat sends in the webhook Authorization header (docs/33).
   * Server-only Worker secret, at least 32 characters; absent = the webhook answers 503.
   */
  REVENUECAT_WEBHOOK_SECRET?: string;
  /** 'true' on staging only: accept RevenueCat SANDBOX events. Production ignores them. */
  BILLING_ALLOW_SANDBOX?: string;
}

export function requireSupabaseConfig(env: ApiEnv): { url: string; publishableKey: string } {
  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error('Supabase is not configured');
  return { url: url.replace(/\/$/, ''), publishableKey };
}

export function requireOpenRouterKey(env: ApiEnv): string {
  if (!env.OPENROUTER_API_KEY) throw new Error('OpenRouter is not configured');
  return env.OPENROUTER_API_KEY;
}

export function actionsGloballyEnabled(env: ApiEnv): boolean {
  return env.GLOBAL_ACTION_EXECUTION === 'true';
}

export function actionDomainEnabled(env: ApiEnv, domain: string): boolean {
  if (domain === 'calendar') return env.ACTION_CALENDAR_EXECUTION === 'true';
  if (domain === 'email') return env.ACTION_EMAIL_EXECUTION === 'true';
  return false;
}

export function autopilotExecutionEnabled(env: ApiEnv): boolean {
  return env.AUTOPILOT_EXECUTION === 'true';
}

export function autopilotClassEnabled(env: ApiEnv, actionClass: string): boolean {
  return (env.AUTOPILOT_ENABLED_CLASSES ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(actionClass);
}
