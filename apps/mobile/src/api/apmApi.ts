import type { LifeGraphSnapshot, PillarName } from '@apm/domain';

export interface ApiOnboardingInput {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
}

const baseUrl = process.env.EXPO_PUBLIC_APM_API_URL?.replace(/\/$/, '');

export function isApmApiConfigured(): boolean {
  return Boolean(baseUrl);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_APM_API_URL is not configured');

  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    throw new Error(`APM API request failed (${response.status})${requestId ? ` · ${requestId}` : ''}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchLifeGraph(accessToken?: string): Promise<LifeGraphSnapshot> {
  const response = await request<{ graph: LifeGraphSnapshot }>('/v1/me/life-graph', {}, accessToken);
  return response.graph;
}

export async function persistOnboarding(
  input: ApiOnboardingInput,
  accessToken?: string,
): Promise<LifeGraphSnapshot> {
  const response = await request<{ graph: LifeGraphSnapshot }>(
    '/v1/onboarding',
    { method: 'PUT', body: JSON.stringify(input) },
    accessToken,
  );
  return response.graph;
}

export async function persistActionCompletion(actionId: string, accessToken?: string): Promise<void> {
  await request(`/v1/next-actions/${encodeURIComponent(actionId)}/complete`, { method: 'POST' }, accessToken);
}
