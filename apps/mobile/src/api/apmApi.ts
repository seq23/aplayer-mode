import type {
  AccountabilityPolicy,
  CoachingStyle,
  DailyPlan,
  LifeGraphSnapshot,
  OperatingModeKey,
  PillarName,
  TrackKey,
  WeeklyCadence,
} from '@apm/domain';

export interface ApiOnboardingInput {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
}

export interface ApiMethodologyIntakeInput extends ApiOnboardingInput {
  timezone?: string;
  goalOutcome?: string;
  goalTargetDate?: string;
  firstNextAction?: string;
  northStar?: string;
  values: string[];
  nonNegotiables: string[];
  failurePatterns: string[];
  bodyContext?: string;
  workMoneyContext?: string;
  mindSpiritLearningContext?: string;
  weeklyCadence: WeeklyCadence;
  coachingStyle: CoachingStyle;
  accountability: AccountabilityPolicy;
  criticalPillars: PillarName[];
  minimumFloors: Partial<Record<PillarName, string>>;
  trackKeys: TrackKey[];
  activeMode?: OperatingModeKey;
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

export async function persistMethodologyIntake(
  input: ApiMethodologyIntakeInput,
  accessToken: string,
): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/intake', accessToken, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function persistOperatingMode(
  mode: OperatingModeKey,
  accessToken: string,
): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/mode', accessToken, {
    method: 'POST',
    body: JSON.stringify({ mode }),
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
