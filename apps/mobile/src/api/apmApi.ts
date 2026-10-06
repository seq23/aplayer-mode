import type {
  AccountabilityPolicy,
  AutonomyLevel,
  CoachingStyle,
  DailyPlan,
  LifeAdminItem,
  LifeAdminKind,
  LifeAdminRecurrence,
  LifeGraphSnapshot,
  LifeRelationship,
  OperatingModeKey,
  Permission,
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
  morningSequence?: string[];
  schedulingPreference?: 'strict_blocks' | 'loose_dayparts' | 'ordered_stack';
  hardBoundaries?: string[];
  scoringConfig?: { enabled: boolean; showSevenDaySnapshot: boolean };
  foregroundProjectName?: string;
  foregroundProjectObjective?: string;
  reviewGateDays?: 30 | 60 | 90;
}

export interface TodayState { graph: LifeGraphSnapshot; plan: DailyPlan }

export interface ProductPlanCard {
  plan: 'beta' | 'chief_of_staff' | 'life_os' | 'autopilot' | 'household';
  displayName: string;
  promise: string;
  publicAvailability: 'beta' | 'available' | 'waitlist';
  capabilities: string[];
  maxAutonomyLevel: AutonomyLevel;
  maxAutonomyLabel: string;
  priceLabel: string;
  highlights: string[];
}

export interface LifeRelationshipInput {
  personId?: string;
  personName?: string;
  relationship?: string;
  email?: string;
  phone?: string;
  birthday?: string;
  nextContactAt?: string;
  cadenceDays?: number | null;
  notes?: string;
}

export interface LifeAdminInput {
  personId?: string;
  kind: LifeAdminKind;
  title: string;
  status?: LifeAdminItem['status'];
  importance?: LifeAdminItem['importance'];
  dueAt?: string;
  startsAt?: string;
  endsAt?: string;
  recurrence?: LifeAdminRecurrence;
  amountMinor?: number | null;
  currency?: string | null;
  details?: Record<string, unknown>;
}

export interface ProductPlanResponse {
  entitlement: {
    userId: string;
    plan: ProductPlanCard['plan'];
    status: 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';
    provider?: string;
    currentPeriodEnd?: string;
    displayName: string;
    promise: string;
    capabilities: string[];
    maxAutonomyLevel: AutonomyLevel;
    maxAutonomyLabel: string;
  };
  plans: ProductPlanCard[];
}


const baseUrl = process.env.EXPO_PUBLIC_APM_API_URL?.replace(/\/$/, '');

export function isApmApiConfigured(): boolean { return Boolean(baseUrl); }

async function request<T>(path: string, accessToken: string, options: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_APM_API_URL is not configured');
  if (!accessToken) throw new Error('An authenticated APM session is required');
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`${body.error ?? 'APM API request failed'} (${response.status})${requestId ? ` · ${requestId}` : ''}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchLifeGraph(accessToken: string): Promise<LifeGraphSnapshot> {
  return (await request<{ graph: LifeGraphSnapshot }>('/v1/me/life-graph', accessToken)).graph;
}
export async function fetchTodayState(accessToken: string): Promise<TodayState> { return request<TodayState>('/v1/me/today', accessToken); }
export async function fetchRetainedLifeOsState(accessToken: string): Promise<{ lifeRelationships: LifeRelationship[]; lifeAdminItems: LifeAdminItem[] }> {
  return request<{ lifeRelationships: LifeRelationship[]; lifeAdminItems: LifeAdminItem[] }>('/v1/privacy/life-os', accessToken);
}
export async function fetchProductPlan(accessToken: string): Promise<ProductPlanResponse> {
  return request<ProductPlanResponse>('/v1/product/plan', accessToken);
}
export async function fetchHouseholdInterest(accessToken: string) {
  return request<{ interested: boolean; updatedAt?: string }>('/v1/product/household-interest', accessToken);
}
export async function setHouseholdInterest(interested: boolean, accessToken: string) {
  return request<{ interested: boolean; updatedAt: string }>('/v1/product/household-interest', accessToken, {
    method: 'PUT',
    body: JSON.stringify({ interested }),
  });
}
export async function createLifeRelationship(input: LifeRelationshipInput, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/life-os/relationships', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function updateLifeRelationship(relationshipId: string, input: Partial<LifeRelationshipInput>, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/life-os/relationships/${encodeURIComponent(relationshipId)}`, accessToken, { method: 'PATCH', body: JSON.stringify(input) });
}
export async function createLifeOsItem(input: LifeAdminInput, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/life-os/items', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function updateLifeOsItem(itemId: string, input: Partial<LifeAdminInput>, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/life-os/items/${encodeURIComponent(itemId)}`, accessToken, { method: 'PATCH', body: JSON.stringify(input) });
}
export async function completeLifeOsItem(itemId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/life-os/items/${encodeURIComponent(itemId)}/complete`, accessToken, { method: 'POST' });
}

export async function persistOnboarding(input: ApiOnboardingInput, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/onboarding', accessToken, { method: 'PUT', body: JSON.stringify(input) });
}
export async function persistMethodologyIntake(input: ApiMethodologyIntakeInput, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/intake', accessToken, { method: 'PUT', body: JSON.stringify(input) });
}
export async function persistOperatingMode(mode: OperatingModeKey, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/mode', accessToken, { method: 'POST', body: JSON.stringify({ mode }) });
}
export async function persistActionCompletion(actionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/next-actions/${encodeURIComponent(actionId)}/complete`, accessToken, { method: 'POST' });
}
export async function closeDay(verdict: 'full_day' | 'mvd' | 'miss', note: string | undefined, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/day/close', accessToken, { method: 'POST', body: JSON.stringify({ verdict, note }) });
}

export async function sendCoachMessage(input: { message: string; sessionId?: string; mode?: OperatingModeKey }, accessToken: string) {
  return request<{ sessionId: string; mode: OperatingModeKey; reply: string; closureReady: boolean; nextAction?: string }>('/v1/apm/coach', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function closeCoachSession(sessionId: string, accessToken: string) {
  return request<{ ok: boolean }>(`/v1/apm/coach/${encodeURIComponent(sessionId)}/close`, accessToken, { method: 'POST' });
}

export async function startOAuthConnection(input: { provider: 'google' | 'microsoft'; kind: 'calendar' | 'email'; codeChallenge: string; redirectUri: string }, accessToken: string) {
  return request<{ state: string; authorizationUrl: string }>('/v1/connections/oauth/start', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function exchangeOAuthConnection(input: { provider: 'google' | 'microsoft'; kind: 'calendar' | 'email'; code: string; codeVerifier: string; state: string; redirectUri: string }, accessToken: string) {
  return request<{ connectionId: string; accountLabel?: string }>('/v1/connections/oauth/exchange', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function syncCloudCalendar(connectionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/calendar/connections/${encodeURIComponent(connectionId)}/sync`, accessToken, { method: 'POST' });
}
export async function syncEmailConnection(connectionId: string, accessToken: string, maxMessages = 25): Promise<TodayState> {
  return request<TodayState>(`/v1/email/connections/${encodeURIComponent(connectionId)}/sync`, accessToken, { method: 'POST', body: JSON.stringify({ maxMessages }) });
}
export async function syncDeviceCalendar(input: { from: string; to: string; events: Array<Record<string, unknown>> }, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/calendar/device/sync', accessToken, { method: 'POST', body: JSON.stringify(input) });
}

export async function setPermission(domain: string, actionType: string, autonomyLevel: AutonomyLevel, accessToken: string, constraints: Record<string, unknown> = {}): Promise<Permission> {
  return (await request<{ permission: Permission }>(`/v1/permissions/${encodeURIComponent(domain)}/${encodeURIComponent(actionType)}`, accessToken, { method: 'PUT', body: JSON.stringify({ autonomyLevel, constraints, enabled: true }) })).permission;
}
export async function prepareExternalAction(input: { domain: 'calendar' | 'email' | 'routine' | 'life_graph' | 'notification' | 'connector'; actionType: string; payload: Record<string, unknown>; reason: string; idempotencyKey: string }, accessToken: string) {
  return request<{ action: LifeGraphSnapshot['actions'][number] }>('/v1/actions/prepare', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function approveExternalAction(actionId: string, accessToken: string) {
  return request<{ action: LifeGraphSnapshot['actions'][number] }>(`/v1/actions/${encodeURIComponent(actionId)}/approve`, accessToken, { method: 'POST' });
}

export async function registerPushToken(input: { expoPushToken: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' }, accessToken: string) {
  return request<{ ok: boolean }>('/v1/push/register', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function evaluateProactivePush(accessToken: string) {
  return request<{ queued: number; sent: number; suppressed: number }>('/v1/push/evaluate', accessToken, { method: 'POST' });
}

export async function fetchModelRoutes(accessToken: string) {
  return request<{ routes: Array<Record<string, unknown>> }>('/v1/trust/model-routes', accessToken);
}
export async function fetchActivity(accessToken: string) {
  return request<{ events: Array<{ id: string; event_type: string; actor_type: string; object_type?: string; object_id?: string; metadata: Record<string, unknown>; created_at: string }> }>('/v1/trust/activity', accessToken);
}
export async function exportMyData(accessToken: string) {
  return request<{ job: { id: string; status: string }; export: { generatedAt: string; lifeGraph: LifeGraphSnapshot; activity: unknown[] } }>('/v1/privacy/export', accessToken, { method: 'POST' });
}
export async function requestDeletion(accessToken: string) {
  return request<{ job: { id: string; status: string }; status: string; note: string }>('/v1/privacy/delete', accessToken, { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) });
}

export async function fetchHouseholds(accessToken: string) {
  return request<{ households: unknown[]; members: unknown[]; items: unknown[] }>('/v1/households', accessToken);
}
export async function createHousehold(name: string, accessToken: string) {
  return request<{ householdId: string }>('/v1/households', accessToken, { method: 'POST', body: JSON.stringify({ name }) });
}
