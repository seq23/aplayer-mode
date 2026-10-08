import type {
  ActionRecord,
  AutopilotActionClass,
  AutopilotDoneItem,
  AutopilotExecution,
  AutopilotRule,
  AutopilotRuleConstraints,
  AutopilotState,
  AutonomyLevel,
  DailyPlan,
  LifeAdminItem,
  LifeAdminKind,
  LifeAdminRecurrence,
  LifeGraphSnapshot,
  LifeRelationship,
  OperatingModeKey,
  Permission,
  AreaKey,
  ActiveTrackKey,
} from '@apm/domain';
import type { DailyAgenda, IntakeInstallPayload } from '@apm/planning';
import { ApiError, networkError } from './errors';

/** The first-run install payload (packages/planning toInstallPayload). */
export type ApiIntakeInstallInput = IntakeInstallPayload;


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
  phase?: 'first_hour' | 'executing';
  redacted: boolean;
  drift: { drifting: boolean; daysAway: number; acknowledged: boolean; message?: string };
  firstWeek?: { day: number; objective: string; success: string; loop: string; rules: string[]; locked: boolean };
  coachingCheckIn: { due: boolean; afterDays: number; daysSince: number; message?: string };
  weeklyReview: { due: boolean; weekStart: string; reviewDay: string };
  bodyReferral?: { since: string; source?: string };
}
export interface WeeklyDebriefView {
  weekStart: string;
  weekEnd: string;
  executionScore: { counted: number; fullDays: number; mvdDays: number; misses: number; unclosed: number; of: 7; percent: number };
  foregroundFocus: { label?: string; daysWithForegroundDone: number; of: 7 };
  friction: string[];
  trackSignals: Array<{ code: string; message: string }>;
  diary: Array<{ kind: string; body: string; localDay: string }>;
  diaryQuestion: string;
  executiveReview: { open: string; close: string };
  adjustmentPrompt: string;
  /** APM's proposed one adjustment, from the week's misses (older servers omit it). */
  suggestedAdjustment?: { text: string; reason: string };
}
export type OsChangeInput =
  | { field: 'morning_sequence' | 'hard_boundaries' | 'non_negotiables' | 'core_values'; value: string[] }
  | { field: 'coaching_firmness'; value: 'gentle' | 'direct' | 'high_pressure' }
  | { field: 'day_start'; value: 'guided' | 'hard' }
  | { field: 'coaching_reminder_days'; value: number }
  | { field: 'show_seven_day_snapshot'; value: boolean }
  | { field: 'review_day' | 'recovery_day'; value: string }
  | { field: 'north_star'; value: string }
  | { field: 'pillar'; value: { name: AreaKey; critical: boolean; minimumFloor?: string } }
  | { field: 'tracks'; value: ActiveTrackKey[] }
  | { field: 'track_settings'; value: { hardStop?: string; homeTouchpoint?: string; movementFloor?: string; bufferMonths?: number; bufferTarget?: number; highInterestDebt?: boolean; debtOrder?: string[] } };
export interface PillarReviewInput { pillar: AreaKey; score: 'hit' | 'partial' | 'miss'; completed?: string }
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
export interface NewGoalInput { title: string; outcome?: string; pillar?: AreaKey; targetDate?: string }
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
  /** The stored assistant turn, so the person can report this exact reply (App Review 1.2 / docs/35). */
  turnId?: string;
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
  /** Paid tiers only (ADR-0004 / ADR-0005). */
  monthlyUsdCents?: number;
  annualUsdCents?: number;
  monthlyPriceLabel?: string;
  annualPriceLabel?: string;
  packages?: { monthly: string; annual: string };
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
    storeProductId?: string;
  };
  /** Store or web (card) subscription state as the verified RevenueCat webhook last wrote it; null when not billed. */
  billing: {
    store: 'app_store' | 'google_play' | 'web';
    period: 'monthly' | 'annual' | null;
    founding: boolean;
    periodEnd: string | null;
    renews: boolean;
    cancelAtPeriodEnd: boolean;
    billingIssue: boolean;
    pendingPlan: 'chief_of_staff' | 'life_os' | 'autopilot' | null;
  } | null;
  plans: ProductPlanCard[];
}

/** The server's decision of which RevenueCat offering this user may see (Founding 100 is server-side). */
export interface BillingOfferingResponse {
  offering: 'default' | 'founding';
  offeringId: string;
  founding: boolean;
  reservedUntil: string | null;
  appUserId: string;
  /** Live Founding 100 count from the server (0062); null when unknown. Never invented. */
  spotsLeft?: number | null;
}

export interface ApiIntakeDraft {
  bankVersion: number;
  version: number;
  answers: Record<string, string | number | boolean | string[]>;
  answeredAt: Record<string, number>;
  cursor: string;
  status?: 'open' | 'installed' | 'pending_edit';
  updatedAt: number;
  installedVersion?: number | null;
}

export interface IntakeSynthesisResult {
  source: 'deterministic' | 'model';
  fallbackReason?: string;
  proposal: {
    trackKeys: string[];
    floors: Record<string, string>;
    extracted: { boundaries: string[]; deadlines: string[]; commitments: string[]; radarSeeds: string[] };
    suggestedAreas: Array<{ label: string; area: string; by: string }>;
  };
}


const baseUrl = process.env.EXPO_PUBLIC_APM_API_URL?.replace(/\/$/, '');

export function isApmApiConfigured(): boolean { return Boolean(baseUrl); }

/** Every API call gives up after this long, so no screen can spin forever (docs/35 E2). */
export const REQUEST_TIMEOUT_MS = 20_000;
let requestTimeoutMs = REQUEST_TIMEOUT_MS;
/** Test hook: a shorter ceiling so the timeout can be proven without waiting 20 s. */
export function setRequestTimeoutMs(ms: number): void { requestTimeoutMs = ms; }

/**
 * Supplies a fresh access token after a 401 (the session layer registers it). An app
 * resumed after an hour in the background holds an expired token until the auth client's
 * own refresh lands; one refresh-and-retry hides that from the person (docs/35 E3).
 */
let refreshAccessToken: (() => Promise<string | undefined>) | undefined;
export function setAccessTokenRefresher(refresher: (() => Promise<string | undefined>) | undefined): void { refreshAccessToken = refresher; }

async function send(url: string, options: RequestInit, accessToken: string): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('content-type', 'application/json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try { return await fetch(url, { ...options, headers, signal: controller.signal }); }
  catch (cause) { throw networkError(cause); }
  finally { clearTimeout(timer); }
}

async function request<T>(path: string, accessToken: string, options: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_APM_API_URL is not configured');
  if (!accessToken) throw new ApiError(401, { error: 'unauthorized' });
  let response = await send(`${baseUrl}${path}`, options, accessToken);
  if (response.status === 401 && refreshAccessToken) {
    const fresh = await refreshAccessToken().catch(() => undefined);
    if (fresh && fresh !== accessToken) response = await send(`${baseUrl}${path}`, options, fresh);
  }
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new ApiError(response.status, body, requestId);
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
export async function fetchBillingOffering(accessToken: string): Promise<BillingOfferingResponse> {
  return request<BillingOfferingResponse>('/v1/billing/offering', accessToken);
}
export type BillingReconcileResponse =
  | { reconciled: true; outcomes: string[] }
  | { reconciled: false; reason: 'not_configured' | 'no_active_subscription' | 'unavailable' | 'rate_limited' };
/**
 * Ask the server to read THIS account's subscription from RevenueCat and apply it (the webhook's
 * safety net after a card checkout). The app never says what was bought; the server asks RevenueCat.
 */
export async function reconcileBilling(accessToken: string): Promise<BillingReconcileResponse> {
  return request<BillingReconcileResponse>('/v1/billing/reconcile', accessToken, { method: 'POST', body: '{}' });
}
/** Web (card) subscribers: the RevenueCat customer-portal link for the signed-in user, or null with a reason. */
export async function fetchWebBillingPortal(accessToken: string) {
  return request<{ url: string | null; reason?: 'not_configured' | 'no_web_subscription' | 'unavailable' }>('/v1/billing/web/portal', accessToken);
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

export async function installIntake(input: ApiIntakeInstallInput, accessToken: string): Promise<TodayState> {
  return request<TodayState>('/v1/methodology/intake', accessToken, { method: 'PUT', body: JSON.stringify(input) });
}
/** Answers given after install: body safety at once, the rest from Day 8 (`held: 'week_one'` before). */
export async function updateIntakeProfile(intakeProfile: unknown, accessToken: string): Promise<TodayState & { held?: 'week_one' }> {
  return request<TodayState & { held?: 'week_one' }>('/v1/intake/profile', accessToken, { method: 'PUT', body: JSON.stringify({ intakeProfile }) });
}
export async function fetchIntakeDraft(accessToken: string): Promise<ApiIntakeDraft | null> {
  return (await request<{ draft: ApiIntakeDraft | null }>('/v1/intake/draft', accessToken)).draft;
}
export async function saveIntakeDraft(draft: ApiIntakeDraft, accessToken: string): Promise<ApiIntakeDraft> {
  const { status: _status, installedVersion: _installed, ...body } = draft;
  void _status; void _installed;
  return (await request<{ draft: ApiIntakeDraft }>('/v1/intake/draft', accessToken, { method: 'PUT', body: JSON.stringify(body) })).draft;
}
export async function mergeAnonymousIntakeDraft(anonymousAccessToken: string, accessToken: string): Promise<{ outcome: string; draft: ApiIntakeDraft | null }> {
  return request('/v1/intake/draft/merge', accessToken, { method: 'POST', body: JSON.stringify({ anonymousAccessToken }) });
}
export async function synthesizeIntake(input: { catchAll?: string; games: string[]; ownership?: boolean; trackKeys: string[]; floors: Record<string, string>; suggestedAreas?: string[] }, accessToken: string): Promise<IntakeSynthesisResult> {
  return request<IntakeSynthesisResult>('/v1/intake/synthesis', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
/** Product analytics: event ids and timings only (the server refuses anything else for intake events). */
export async function trackEvent(eventName: string, properties: Record<string, string | number | boolean | null>, accessToken: string): Promise<void> {
  await request('/v1/analytics/event', accessToken, { method: 'POST', body: JSON.stringify({ eventName, properties }) });
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

export async function logDiaryEntry(input: { kind: 'diary' | 'breakthrough' | 'slip'; body: string }, accessToken: string) {
  return request<TodayState & { reply: string }>('/v1/diary', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function setTodayPhase(phase: 'first_hour' | 'executing', accessToken: string) {
  return request<TodayState>('/v1/today/phase', accessToken, { method: 'POST', body: JSON.stringify({ phase }) });
}
export async function returnAndReset(accessToken: string) {
  return request<TodayState>('/v1/today/return', accessToken, { method: 'POST' });
}
export async function reprintToday(itemIds: string[], accessToken: string) {
  return request<TodayState & { replaced: Array<{ from: string; to?: string }>; stillInvalid: string[] }>('/v1/today/reprint', accessToken, { method: 'POST', body: JSON.stringify({ itemIds }) });
}
export async function fetchWeeklyDebrief(accessToken: string) {
  return request<{ debrief: WeeklyDebriefView; due: { due: boolean; weekStart: string; reviewDay: string } }>('/v1/reviews/weekly', accessToken);
}
export async function completeWeeklyReview(adjustment: string | undefined, accessToken: string) {
  return request<TodayState & { debrief: WeeklyDebriefView }>('/v1/reviews/weekly', accessToken, { method: 'POST', body: JSON.stringify(adjustment ? { adjustment } : {}) });
}
export async function draftOsChange(input: OsChangeInput & { reason?: string }, accessToken: string) {
  return request<TodayState & { change: { id: string } }>('/v1/os/changes', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function applyOsChange(changeId: string, accessToken: string) {
  return request<TodayState & { message: string }>(`/v1/os/changes/${encodeURIComponent(changeId)}/apply`, accessToken, { method: 'POST' });
}
export async function discardOsChange(changeId: string, accessToken: string) {
  return request<TodayState>(`/v1/os/changes/${encodeURIComponent(changeId)}/discard`, accessToken, { method: 'POST' });
}
export async function recordClinicianClearance(accessToken: string) {
  return request<TodayState>('/v1/body/clearance', accessToken, { method: 'POST', body: JSON.stringify({ confirm: true }) });
}

export async function sendCoachMessage(input: { message?: string; choice?: CoachChoice; sessionId?: string }, accessToken: string): Promise<CoachReplyView> {
  return request<CoachReplyView>('/v1/apm/coach', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export type CoachReportReason = 'harmful' | 'wrong' | 'inappropriate' | 'other';
/** "Report this" on a coach reply: stored server-side with an audit row (migration 0066). */
export async function reportCoachReply(input: { turnId: string; reason: CoachReportReason; note?: string }, accessToken: string): Promise<{ reportId: string }> {
  return request<{ reportId: string }>('/v1/apm/coach/report', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function closeCoachSession(sessionId: string, accessToken: string) {
  return request<{ ok: boolean }>(`/v1/apm/coach/${encodeURIComponent(sessionId)}/close`, accessToken, { method: 'POST' });
}

/** `access: 'act'` asks the provider for write scopes as a separate, explicit consent (Autopilot); the default is read-only. */
export async function startOAuthConnection(input: { provider: 'google' | 'microsoft'; kind: 'calendar' | 'email'; codeChallenge: string; redirectUri: string; access?: 'read' | 'act'; intent?: 'add' | 'reconnect' }, accessToken: string) {
  return request<{ state: string; authorizationUrl: string }>('/v1/connections/oauth/start', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function exchangeOAuthConnection(input: { provider: 'google' | 'microsoft'; kind: 'calendar' | 'email'; code: string; codeVerifier: string; state: string; redirectUri: string }, accessToken: string) {
  return request<{ connectionId: string; accountLabel?: string }>('/v1/connections/oauth/exchange', accessToken, { method: 'POST', body: JSON.stringify(input) });
}
// Connected accounts (0065): label, primary, reactivate and disconnect are governed RPCs.
export async function setConnectionLabel(connectionId: string, label: string | null, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/connections/${encodeURIComponent(connectionId)}`, accessToken, { method: 'PATCH', body: JSON.stringify({ label }) });
}
export async function setPrimaryConnection(connectionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/connections/${encodeURIComponent(connectionId)}/primary`, accessToken, { method: 'POST' });
}
export async function reactivateConnection(connectionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/connections/${encodeURIComponent(connectionId)}/reactivate`, accessToken, { method: 'POST' });
}
export async function disconnectConnection(connectionId: string, accessToken: string): Promise<TodayState> {
  return request<TodayState>(`/v1/connections/${encodeURIComponent(connectionId)}/disconnect`, accessToken, { method: 'POST' });
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

export async function unregisterPushToken(expoPushToken: string, accessToken: string) {
  return request<{ ok: boolean }>('/v1/push/unregister', accessToken, { method: 'POST', body: JSON.stringify({ expoPushToken }) });
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
export type AutopilotDomain = 'calendar' | 'email' | 'appointment' | 'subscription';
export interface AutopilotOverview {
  autopilot: AutopilotState;
  permissions: Array<{ actionClass: AutopilotActionClass; domain: AutopilotDomain; autonomyLevel: AutonomyLevel }>;
  supported: Array<{ actionClass: AutopilotActionClass; domain: AutopilotDomain; connector: 'calendar' | 'email'; label: string; reversible: boolean; undo: string; undoLabel: string }>;
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
export async function runAutopilotRule(ruleId: string, input: { idempotencyKey: string; reason: string; payload: Record<string, unknown> }, accessToken: string): Promise<{ replayed: boolean; stopped?: 'payment_required' | 'needs_user'; execution?: AutopilotExecution; action: ActionRecord }> {
  return request(`/v1/autopilot/rules/${encodeURIComponent(ruleId)}/run`, accessToken, { method: 'POST', body: JSON.stringify(input) });
}
export async function undoAutopilotExecution(executionId: string, accessToken: string): Promise<AutopilotExecution> {
  return (await request<{ execution: AutopilotExecution }>(`/v1/autopilot/executions/${encodeURIComponent(executionId)}/undo`, accessToken, { method: 'POST' })).execution;
}
/** Today's done-list: each run with Undo or a clear "can't undo"; stops show as "needs you". */
export async function fetchAutopilotDone(accessToken: string, day?: string): Promise<{ day: string; items: AutopilotDoneItem[] }> {
  return request(`/v1/autopilot/done${day ? `?day=${encodeURIComponent(day)}` : ''}`, accessToken);
}
export async function setAutopilotEventFlexible(eventId: string, flexible: boolean, accessToken: string): Promise<{ eventId: string; flexible: boolean }> {
  return request(`/v1/autopilot/flexible-events/${encodeURIComponent(eventId)}`, accessToken, { method: 'PUT', body: JSON.stringify({ flexible }) });
}
export async function fetchRetainedAutopilotState(accessToken: string): Promise<{ rules: AutopilotRule[]; executions: AutopilotExecution[]; masterPaused: boolean }> {
  return request('/v1/privacy/autopilot', accessToken);
}

/**
 * App Review demo sign-in (docs/33 §8). Off unless the server has APP_REVIEW_EMAIL and
 * APP_REVIEW_CODE set; then it answers ONLY for that one address. Without `code` it says
 * whether to skip the email step; with the code it returns a session for that account.
 */
export async function reviewerSignIn(input: { email: string; code?: string }): Promise<{ review: true; session?: { access_token: string; refresh_token: string } } | null> {
  if (!baseUrl) return null;
  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try { response = await fetch(`${baseUrl}/v1/auth/review-login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input), signal: controller.signal }); }
    finally { clearTimeout(timer); }
  } catch { return null; }
  if (!response.ok) return null;
  return response.json() as Promise<{ review: true; session?: { access_token: string; refresh_token: string } }>;
}
