import type { ActionDomain } from '@apm/policy';

export interface ApiEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
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
  ACTION_ROUTINE_EXECUTION?: string;
  ACTION_LIFE_GRAPH_EXECUTION?: string;
  ACTION_NOTIFICATION_EXECUTION?: string;
  ACTION_CONNECTOR_EXECUTION?: string;
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

export function actionDomainEnabled(env: ApiEnv, domain: ActionDomain): boolean {
  const values: Record<ActionDomain, string | undefined> = {
    calendar: env.ACTION_CALENDAR_EXECUTION,
    email: env.ACTION_EMAIL_EXECUTION,
    routine: env.ACTION_ROUTINE_EXECUTION,
    life_graph: env.ACTION_LIFE_GRAPH_EXECUTION,
    purchase: undefined,
    notification: env.ACTION_NOTIFICATION_EXECUTION,
    connector: env.ACTION_CONNECTOR_EXECUTION,
  };
  return values[domain] === 'true';
}
