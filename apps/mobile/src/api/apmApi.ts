import type {
  AccountabilityPolicy,
  ActionRecord,
  AutopilotActionClass,
  AutopilotExecution,
  AutopilotRule,
  AutopilotRuleConstraints,
  AutopilotState,
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
  ActiveTrackKey,
  WeeklyCadence,
} from '@apm/domain';
import type { DailyAgenda } from '@apm/planning';

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
  trackKeys: ActiveTrackKey[];
  activeMode?: OperatingModeKey;
  morningSequence?: string[];
  schedulingPreference?: 'strict_blocks' | 'loose_dayparts' | 'ordered_stack';
  hardBoundaries?: string[];
  scoringConfig?: { enabled: boolean; showSevenDaySnapshot: boolean };
  foregroundProjectName?: string;
  foregroundProjectObjective?: string;
  reviewGateDays?: 30 | 60 | 90;
}

export interface ModeDefinitionView { key: OperatingModeKey; name: string; purpose: string; rules: string[]; exitProtocol: string; todayEffect: string }
export interface ModeStateView {
  mode: OperatingModeKey;
  startedAt?: string;
  endsAt?: string;
  focus?: string;
  recoveryLockedUntil?: string;
  resume?: { mode: OperatingModeKey; endsAt?: string; focus?: string };
  definition: ModeDefinitionView;
  recoveryLocked: boolean;
  canExit: boolean;
  todayEffect?: { mode: OperatingModeKey; summary: string; heldBlocks: Array<{ id: string; title: string }>; heldUntil?: string };
}
/** The BHPC daily loop for the user's local today (services/api/src/dailyLoop.ts). */
export interface TodayLoopView {
  date: string;
  agenda: DailyAgenda;
  dayState: { state: 'normal' | 'recovery' | 'missed_yesterday'; reason: string };
  locked: boolean;
  checkedIn: boolean;
  closed: boolean;
  dayStart: 'guided' | 'hard';
  day?: { mood?: number; verdict?: 'full_day' | 'mvd' | 'miss'; computedVerdict?: 'full_day' | 'mvd' | 'miss'; carryForward?: string; insight?: string; note?: string; replans: Array<{ reason: string; detail?: string; at: string }> };
  continuity: Array<{ day: string; verdict?: 'full_day' | 'mvd' | 'miss'; symbol: string }>;
  showContinuity: boolean;
  closePreview: { pillarReview: PillarReviewInput[]; computedVerdict: 'full_day' | 'mvd' | 'miss'; evidence: string[] };
}
export interface PillarReviewInput { pillar: PillarName | 'family'; score: 'hit' | 'partial' | 'miss'; completed?: string }
export interface NotificationPreferences {
  enabled: boolean;
  morning_push_enabled: boolean;
  wake_time: string;
  lock_screen_detail: 'minimal' | 'normal';
  quiet_hours: { start?: string; end?: string };
  minimum_severity: string;
}
export interface TodayState { graph: LifeGraphSnapshot; plan: DailyPlan; mode?: ModeStateView; today?: TodayLoopView }
export type ReplanReason = 'external_change' | 'safety' | 'permission' | 'mood' | 'discomfort';
export interface NewGoalInput { title: string; outcome?: string; pillar?: PillarName; targetDate?: string }
export interface CreatedGoalState extends TodayState {
  goalId: string;
  arbitration: { winnerId?: string; ranked: Array<{ id: string; score: number }> } | null;
  recommendedForegroundGoalId: string | null;
}

export type ModeChangeRequest =
  | { action: 'exit' }
  | { action?: 'enter'; mode: 'standard' | 'high_pressure' | 'executive_review' | 'recovery' }
  | { action?: 'enter'; mode: 'sprint'; days: number }
  | { action?: 'enter'; mode: 'deep_work'; minutes: number; focus: string };

export type CoachChoice = 'close_and_launch' | 'go_deeper' | 'sequence_done' | 'stay_in_block' | 'end_block_early' | 'im_safe' | 'need_help_now' | 'open_today' | 'end_session';
export interface CoachPromptView { kind: 'question' | 'choice' | 'confirm'; text: string; options: Array<{ id: CoachChoice; label: string }> }
export interface CoachReplyView {
  sessionId: string;
  mode: OperatingModeKey;
  phase: 'exploring' | 'closure_offered' | 'morning_sequence' | 'closed' | 'safety_stop';
  step: string;
  engine: 'scripted' | 'model';
  reply: string;
  prompt: CoachPromptView;
  nextMove?: string;
  morningSequence?: string[];
  review?: { opening: string; items: Array<{ area: string; text: string }>; closing: string; directive: string };
  safety?: { level: 'crisis' | 'medical' | 'therapy_scope' | 'none'; resources: Array<{ label: string; detail: string; action?: { kind: 'call' | 'text' | 'url'; value: string } }> };
  boundaryNote?: string;
  trackChallenges: string[];
  modeState?: ModeStateView;
  /** Present when the turn changed the mode: the rebuilt server Today state. */
  today?: TodayState;
}

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
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(`${body.message ?? body.error ?? 'APM API request failed'} (${response.status})${requestId ? ` · ${requestId}` : ''}`);
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
export async function persistOperatingMode(modeRequest: ModeChangeRequest, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/mode', accessToken, { method: 'POST', body: JSON.stringify(modeRequest) });
}
export async function persistActionCompletion(actionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/next-actions/${encodeURIComponent(actionId)}/complete`, accessToken, { method: 'POST' });
}
export async function closeDay(verdict: 'full_day' | 'mvd' | 'miss', note: string | undefined, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/day/close', accessToken, { method: 'POST', body: JSON.stringify({ verdict, note }) });
}

export async function checkInToday(mood: number, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/today/check-in', accessToken, { method: 'POST', body: JSON.stringify({ mood }) });
}
export async function completeAgendaAction(input: { planId: string; actionKey: string; note?: string }, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/today/actions/complete', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function replanToday(input: { reason: ReplanReason; detail?: string }, accessToken: string): Promise<TodayState & { message?: string }> {
  return request<TodayState & { message?: string }>('/v1/today/replan', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function createGoal(input: NewGoalInput, accessToken: string): Promise<CreatedGoalState> {
  return request<CreatedGoalState>('/v1/goals', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function setForegroundGoal(goalId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/goals/${encodeURIComponent(goalId)}/foreground`, accessToken, { method: 'POST' });
}
export async function reviewPlanGate(planId: string, input: { gate: 'foundation' | 'build'; stillAligned: boolean }, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/goal-plans/${encodeURIComponent(planId)}/gate-review`, accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function decideGoalPlan(planId: string, input: { decision: 'promote' | 'maintain' | 'park'; reason: string }, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/goal-plans/${encodeURIComponent(planId)}/decision`, accessToken, { method: 'POST', body: JSON.stringify(input) });
}

export async function closeToday(input: { pillarReview: PillarReviewInput[]; verdict?: 'full_day' | 'mvd' | 'miss'; note?: string; carryForward?: string }, accessToken: string) {
  return request<TodayState & { verdict: string; computedVerdict: string; insight: string; carryForward: string | null }>('/v1/today/close', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function fetchNotificationPreferences(accessToken: string) {
  return request<{ preferences: NotificationPreferences | null }>('/v1/notifications/preferences', accessToken);
}
export async function saveNotificationPreferences(input: { enabled?: boolean; morningPushEnabled?: boolean; wakeTime?: string; lockScreenDetail?: 'minimal' | 'normal'; quietHours?: { start: string; end: string } | Record<string, never> }, accessToken: string) {
  return request<{ preferences: NotificationPreferences | null }>('/v1/notifications/preferences', accessToken, { method: 'PUT', body: JSON.stringify(input) });
}

export async function sendCoachMessage(input: { message?: string; choice?: CoachChoice; sessionId?: string }, accessToken: string): Promise<CoachReplyView> {
  return request<CoachReplyView>('/v1/apm/coach', accessToken, { method: 'POST', body: JSON.stringify(input) });
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

// Phase C — Autopilot standing rules. The server and database decide; these
// calls only express the user's explicit grants, pauses and revocations.
export interface AutopilotOverview {
  autopilot: AutopilotState;
  permissions: Array<{ actionClass: AutopilotActionClass; domain: 'calendar' | 'email'; autonomyLevel: AutonomyLevel }>;
  supported: Array<{ actionClass: AutopilotActionClass; domain: 'calendar' | 'email'; label: string; reversible: boolean; undo: string }>;
  neverStanding: Array<{ match: string; reason: string }>;
}
export async function fetchAutopilot(accessToken: string): Promise<AutopilotOverview> {
  return request<AutopilotOverview>('/v1/autopilot', accessToken);
}
export async function grantAutopilotRule(input: { actionClass: AutopilotActionClass; constraints: AutopilotRuleConstraints; expiresAt: string }, accessToken: string): Promise<AutopilotRule> {
  return (await request<{ rule: AutopilotRule }>('/v1/autopilot/rules', accessToken, { method: 'POST', body: JSON.stringify(input) })).rule;
}
export async function updateAutopilotRule(ruleId: string, input: { expectedVersion: number; constraints?: AutopilotRuleConstraints; expiresAt?: string }, accessToken: string): Promise<AutopilotRule> {
  return (await request<{ rule: AutopilotRule }>(`/v1/autopilot/rules/${encodeURIComponent(ruleId)}`, accessToken, { method: 'PATCH', body: JSON.stringify(input) })).rule;
}
export async function setAutopilotRuleStatus(ruleId: string, next: 'pause' | 'resume', expectedVersion: number, accessToken: string): Promise<AutopilotRule> {
  return (await request<{ rule: AutopilotRule }>(`/v1/autopilot/rules/${encodeURIComponent(ruleId)}/${next}`, accessToken, { method: 'POST', body: JSON.stringify({ expectedVersion }) })).rule;
}
export async function revokeAutopilotRule(ruleId: string, accessToken: string, reason?: string): Promise<AutopilotRule> {
  return (await request<{ rule: AutopilotRule }>(`/v1/autopilot/rules/${encodeURIComponent(ruleId)}/revoke`, accessToken, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) })).rule;
}
export async function setAutopilotPaused(paused: boolean, accessToken: string): Promise<{ paused: boolean }> {
  return request<{ paused: boolean }>('/v1/autopilot/pause', accessToken, { method: 'PUT', body: JSON.stringify({ paused }) });
}
export async function runAutopilotRule(ruleId: string, input: { idempotencyKey: string; reason: string; payload: Record<string, unknown> }, accessToken: string): Promise<{ replayed: boolean; execution: AutopilotExecution; action: ActionRecord }> {
  return request(`/v1/autopilot/rules/${encodeURIComponent(ruleId)}/run`, accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function undoAutopilotExecution(executionId: string, accessToken: string): Promise<AutopilotExecution> {
  return (await request<{ execution: AutopilotExecution }>(`/v1/autopilot/executions/${encodeURIComponent(executionId)}/undo`, accessToken, { method: 'POST' })).execution;
}
export async function fetchRetainedAutopilotState(accessToken: string): Promise<{ rules: AutopilotRule[]; executions: AutopilotExecution[]; masterPaused: boolean }> {
  return request('/v1/privacy/autopilot', accessToken);
}
