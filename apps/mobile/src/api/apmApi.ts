import type { DailyPlan, LifeGraphSnapshot, PillarName } from '@apm/domain';

export interface ApiOnboardingInput {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
}

export interface TodayState {
  graph: LifeGraphSnapshot;
  plan: DailyPlan;
}

const baseUrl = process.env.EXPO_PUBLIC_APM_API_URL?.replace(/\/$/, '');

export function isApmApiConfigured(): boolean {
  return Boolean(baseUrl);
}

async function request<T>(
  path: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_APM_API_URL is not configured');
  if (!accessToken) throw new Error('An authenticated APM session is required');

  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('content-type', 'application/json');

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    throw new Error(`APM API request failed (${response.status})${requestId ? ` · ${requestId}` : ''}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchLifeGraph(accessToken: string): Promise<LifeGraphSnapshot> {
  const response = await request<{ graph: LifeGraphSnapshot }>('/v1/me/life-graph', accessToken);
  return response.graph;
}

export async function fetchTodayState(accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/me/today', accessToken);
}

export async function persistOnboarding(
  input: ApiOnboardingInput,
  accessToken: string,
): Promise<TodayState> {
  return request<TodayState>('/v1/onboarding', accessToken, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function persistActionCompletion(
  actionId: string,
  accessToken: string,
): Promise<TodayState> {
  return request<TodayState>(`/v1/next-actions/${encodeURIComponent(actionId)}/complete`, accessToken, {
    method: 'POST',
  });
}
