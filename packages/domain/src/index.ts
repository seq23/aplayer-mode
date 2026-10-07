export type UUID = string;
export type ISODateTime = string;

export type ProvenanceKind = 'stated' | 'observed' | 'inferred' | 'imported';
export type SourceType = 'conversation' | 'gmail' | 'outlook' | 'calendar' | 'manual' | 'system';

export interface Provenance {
  kind: ProvenanceKind;
  sourceType: SourceType;
  sourceRef?: string;
  confidence?: number;
  createdAt: ISODateTime;
  lastConfirmedAt?: ISODateTime;
  userCorrectedAt?: ISODateTime;
}

export interface UserIdentity {
  userId: UUID;
  displayName: string;
  timezone?: string;
  currentSeason?: string;
  becoming?: string;
}

export interface Role {
  id: UUID;
  userId: UUID;
  name: string;
  active: boolean;
  provenance: Provenance;
}

/**
 * The three pillars (owner decision 7 Oct 2026, supersedes the four-pillar model of
 * docs/20): Mind, Body and Spirit. Everyone starts with all three; a whole pillar can be
 * switched off. Everything the engine plans, floors and scores lives one level down, in
 * an AREA (`AreaKey`), and rolls up to its pillar for display and the day verdict.
 */
export type PillarName = 'mind' | 'body' | 'spirit';

export const PILLAR_NAMES: readonly PillarName[] = ['mind', 'body', 'spirit'];

export const PILLAR_LABELS: Readonly<Record<PillarName, string>> = { mind: 'Mind', body: 'Body', spirit: 'Spirit' };

/**
 * The areas inside the three pillars. The engine works at this level (critical/flexible,
 * floors, MVD, scoring), exactly as BHPC's pillars did. The database (migration 0060)
 * checks the same list.
 */
export const AREA_KEYS = [
  // Mind
  'work', 'money', 'learning', 'focus', 'mental_health',
  // Body
  'movement', 'food', 'sleep', 'weight', 'health_routines',
  // Spirit
  'faith', 'meditation', 'gratitude', 'nature', 'service', 'family',
] as const;

export type AreaKey = (typeof AREA_KEYS)[number];

/** Which pillar each area rolls up to. */
export const AREA_PILLAR: Readonly<Record<AreaKey, PillarName>> = {
  work: 'mind', money: 'mind', learning: 'mind', focus: 'mind', mental_health: 'mind',
  movement: 'body', food: 'body', sleep: 'body', weight: 'body', health_routines: 'body',
  faith: 'spirit', meditation: 'spirit', gratitude: 'spirit', nature: 'spirit', service: 'spirit', family: 'spirit',
};

export const AREA_LABELS: Readonly<Record<AreaKey, string>> = {
  work: 'Work', money: 'Money', learning: 'Learning', focus: 'Focus & screen boundaries', mental_health: 'Mental health',
  movement: 'Movement & fitness', food: 'Food & hydration', sleep: 'Sleep', weight: 'Weight', health_routines: 'Health routines',
  faith: 'Faith', meditation: 'Meditation & mindfulness', gratitude: 'Gratitude', nature: 'Nature & stillness', service: 'Service & giving', family: 'Family & relationships',
};

export function isAreaKey(value: unknown): value is AreaKey {
  return typeof value === 'string' && (AREA_KEYS as readonly string[]).includes(value);
}

export function pillarOfArea(area: AreaKey): PillarName {
  return AREA_PILLAR[area];
}

export function areasOfPillar(pillar: PillarName): AreaKey[] {
  return AREA_KEYS.filter((area) => AREA_PILLAR[area] === pillar);
}

/** The pre-0060 pillar keys. Kept only to migrate stored data and old payloads. */
export type LegacyPillarKey = 'wealth' | 'body' | 'spirit' | 'execution' | 'family';

/**
 * Legacy key → area (migration 0060 applies the same table in SQL). `spirit` had no
 * finer meaning, so its area is read from the floor text when one exists
 * (`legacySpiritArea`), else Meditation & mindfulness.
 */
export const LEGACY_AREA_MAP: Readonly<Record<LegacyPillarKey, AreaKey>> = {
  execution: 'work',
  wealth: 'money',
  body: 'movement',
  spirit: 'meditation',
  family: 'family',
};

export function legacySpiritArea(floorText?: string): AreaKey {
  const text = (floorText ?? '').toLowerCase();
  if (/(pray|prayer|scripture|bible|quran|qur'an|torah|church|mosque|temple|synagogue|worship|devotion|god)/.test(text)) return 'faith';
  if (/(gratitude|grateful|thankful)/.test(text)) return 'gratitude';
  if (/(nature|outside|outdoors|walk in|stillness|sunlight)/.test(text)) return 'nature';
  if (/(volunteer|serve|service|give|giving|donat)/.test(text)) return 'service';
  return 'meditation';
}

/** Maps an old pillar key (or an area key, unchanged) to an area. Unknown → undefined. */
export function toAreaKey(value: string | null | undefined, floorText?: string): AreaKey | undefined {
  if (!value) return undefined;
  if (isAreaKey(value)) return value;
  if (value === 'spirit') return legacySpiritArea(floorText);
  return (LEGACY_AREA_MAP as Record<string, AreaKey>)[value];
}

/**
 * A plan-level area. Plans, plan actions, agendas and reviews carry an area in their
 * `pillar` field (the JSON field name predates the three-pillar model and is kept so stored
 * plans stay valid); `lifePillarOf` rolls it up.
 */
export type PlanPillar = AreaKey;

/** The pillar a plan area rolls up to. */
export function lifePillarOf(area: PlanPillar): PillarName {
  return AREA_PILLAR[area];
}

/** One AREA's settings (table pillar_settings; `name` is the area key since 0060). */
export interface PillarSetting {
  userId: UUID;
  name: AreaKey;
  /** The pillar the area rolls up to (stored as a generated column). */
  pillar: PillarName;
  active: boolean;
  critical: boolean;
  minimumFloor?: string;
}

/**
 * The installable Track set (migration 0020): the four BHPC Tracks plus the
 * three app-only Tracks. The database check constraint, the API schema and the
 * coaching Track library all use exactly this list.
 */
export type ActiveTrackKey =
  | 'billionaire_mindset'
  | 'operator_discipline'
  | 'strategic_patience'
  | 'resilience'
  | 'body_foundation'
  | 'wealth_foundation'
  | 'home_front';

/**
 * Retired in migration 0020 (rows removed, each recorded as a `track.retired`
 * audit event). Kept only so the retirement itself can be described; it is NOT a
 * TrackKey and no API, mobile, planning or database path accepts these keys.
 */
export type RetiredTrackKey = 'manifestation_mastery' | 'investor_ai_leverage';

/** The Track key: exactly the seven installable Tracks. */
export type TrackKey = ActiveTrackKey;

/**
 * THE single Track display-name map, shared by mobile and API. The owner is still
 * naming Tracks, so names live only here; keys are stable and stored names in the
 * database are never shown.
 */
export const TRACK_DISPLAY_NAMES: Readonly<Record<ActiveTrackKey, string>> = {
  billionaire_mindset: 'Billionaire High Performance Coach Track',
  operator_discipline: 'Operator Discipline Track',
  strategic_patience: 'Strategic Patience Track',
  resilience: 'Resilience Track',
  body_foundation: 'Body Foundation Track',
  wealth_foundation: 'Wealth Foundation Track',
  home_front: 'Home Front Track',
};

export function trackDisplayName(key: ActiveTrackKey): string {
  return TRACK_DISPLAY_NAMES[key];
}

export interface Track {
  id: UUID;
  userId: UUID;
  key: ActiveTrackKey;
  name: string;
  active: boolean;
  foreground: boolean;
  provenance: Provenance;
}

export type OperatingModeKey =
  | 'standard'
  | 'recovery'
  | 'high_pressure'
  | 'executive_review'
  | 'sprint'
  | 'deep_work';

export interface OperatingMode {
  id: UUID;
  userId: UUID;
  key: OperatingModeKey;
  name: string;
  active: boolean;
  provenance: Provenance;
}

export interface WeeklyCadence {
  heavyDays: string[];
  lightDays: string[];
  reviewDay?: string;
  recoveryDay?: string;
}

export interface CoachingStyle {
  firmness: 'gentle' | 'direct' | 'high_pressure';
  helpfulLanguage?: string;
  avoidLanguage?: string;
}

export interface AccountabilityPolicy {
  dayStart: 'guided' | 'hard';
  coachingReminderAfterDays?: number;
}

export interface ScoringConfig {
  enabled: boolean;
  showSevenDaySnapshot: boolean;
}

/** Track settings on the Personal OS (migration 0027), edited through the OS change flow. */
export interface TrackSettings {
  /** Home Front: the declared end of the workday, HH:MM local. */
  hardStop?: string;
  homeTouchpoint?: string;
  /** Body Foundation: the movement floor (never zero). */
  movementFloor?: string;
  /** Wealth Foundation: months of expenses held, target, and whether high-interest debt remains. */
  bufferMonths?: number;
  bufferTarget?: number;
  highInterestDebt?: boolean;
  /** Wealth Foundation: debts in the user's chosen payoff order. */
  debtOrder?: string[];
}

/**
 * The structured profile the first-run intake produces (docs/34 §4, the fields marked NEW).
 * Only closed-answer ids, numbers and times: the optional catch-all text never lands here.
 * Stored on personal_os.intake_profile (migration 0060).
 */
export interface IntakeProfile {
  bankVersion: number;
  games: string[];
  foregroundGame?: string;
  loadBaseline?: number;
  mentalLoadItems: string[];
  wakeTime?: string;
  sleepTime?: string;
  fixedCommitments: string[];
  /** Line ids she asked APM to hold (non-negotiables + boundaries, docs/34 Q53). */
  lineIds: string[];
  travelPattern?: string;
  defaultMinutes?: number;
  missPattern?: string;
  energyDip?: string;
  deadlines: string[];
  deadlineWindow?: string;
  realWork: string[];
  fakeWork: string[];
  wealthContext: string[];
  ownership?: boolean;
  careerLevers: string[];
  family?: { dependents: string[]; protected: string[]; shared?: string };
  /** Mind practices APM supplies (journaling, reading, learning plan, focus, therapy, reflection). */
  mindPractices: string[];
  learningTopic?: string;
  learningModality?: string;
  /** Spirit practices ("What feeds your spirit?"). */
  spiritPractices: string[];
  faithLanguage: boolean;
  practiceCadence?: 'daily' | 'few' | 'weekly';
  bedRoutine?: { gentle: boolean };
  /** Body safety question: a listed condition applies (`yes`) or she would rather not say (`skip`) → body pace paused until a clinician clears it. */
  bodySafety?: 'none' | 'yes' | 'skip';
  coachingHelps: string[];
  coachingAvoid: string[];
  morningTrigger?: 'wake' | 'wake15' | 'wake30';
  systemName?: string;
  quickStart: boolean;
  /** Question ids left for "2 quick taps" on Today. */
  deferredQuestionIds: string[];
  /** Areas the user suggested (catch-all or the summary chip), already classified. */
  suggestedAreas: Array<{ label: string; area: AreaKey }>;
}

export interface PersonalOS {
  userId: UUID;
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
  activeMode: OperatingModeKey;
  foregroundGoalId?: UUID;
  morningSequence: string[];
  schedulingPreference: 'strict_blocks' | 'loose_dayparts' | 'ordered_stack';
  hardBoundaries: string[];
  scoringConfig: ScoringConfig;
  stabilizationStartedAt?: string;
  trackSettings: TrackSettings;
  /** The pillars switched on (all three by default; unticking one switches its areas off). */
  pillarsEnabled: PillarName[];
  intakeProfile?: IntakeProfile;
  /** Body red-flag pause: set until the user records clinician clearance. */
  bodyReferral?: { since: ISODateTime; source?: string };
  clinicianClearedAt?: ISODateTime;
  installedAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Goal {
  id: UUID;
  userId: UUID;
  title: string;
  outcome?: string;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  health: 'on_track' | 'at_risk' | 'stalled' | 'unknown';
  /** The goal's area (field name predates the three-pillar model). */
  pillar?: AreaKey;
  targetDate?: string;
  priority: number;
  provenance: Provenance;
}

export interface Milestone {
  id: UUID;
  userId: UUID;
  goalId: UUID;
  projectId?: UUID;
  title: string;
  status: 'open' | 'complete' | 'missed' | 'parked';
  dueAt?: ISODateTime;
}

export interface Project {
  id: UUID;
  userId: UUID;
  goalId?: UUID;
  title: string;
  objective?: string;
  status: 'active' | 'paused' | 'complete' | 'parked';
  foreground: boolean;
  reviewGateDays?: 30 | 60 | 90;
  reviewGateAt?: string;
}

export type CommitmentStatus =
  | 'captured'
  | 'understood'
  | 'prioritized'
  | 'scheduled'
  | 'executed'
  | 'verified'
  | 'closed'
  | 'dismissed'
  | 'corrected'
  | 'deferred';

export interface Commitment {
  id: UUID;
  userId: UUID;
  projectId?: UUID;
  goalId?: UUID;
  personId?: UUID;
  title: string;
  owner: 'user' | 'other';
  status: CommitmentStatus;
  dueAt?: ISODateTime;
  provenance: Provenance;
}

export interface NextAction {
  id: UUID;
  userId: UUID;
  projectId?: UUID;
  goalId?: UUID;
  commitmentId?: UUID;
  title: string;
  status: 'open' | 'scheduled' | 'done' | 'dismissed';
  estimatedMinutes?: number;
}

export interface Routine {
  id: UUID;
  userId: UUID;
  title: string;
  pillar?: AreaKey;
  targetFrequencyPerWeek?: number;
  preferredWindow?: Record<string, unknown>;
  active: boolean;
  minimumVersion?: string;
  provenance: Provenance;
}

export interface Person {
  id: UUID;
  userId: UUID;
  name: string;
  relationship?: string;
  email?: string;
  phone?: string;
  provenance: Provenance;
}

export interface LifeRelationship {
  id: UUID;
  userId: UUID;
  personId: UUID;
  birthday?: string;
  nextContactAt?: ISODateTime;
  cadenceDays?: number;
  notes?: string;
  provenance: Provenance;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type LifeAdminKind =
  | 'appointment'
  | 'trip'
  | 'bill'
  | 'subscription'
  | 'meal_plan'
  | 'shopping'
  | 'health_routine'
  | 'recurring_obligation'
  | 'family_obligation';

export type LifeAdminStatus = 'open' | 'planned' | 'scheduled' | 'completed' | 'paused' | 'cancelled';

export interface LifeAdminRecurrence {
  frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  /** Internal canonical anchors preserve intended dates across clamped month/year occurrences. */
  anchorDueAt?: ISODateTime;
  anchorStartsAt?: ISODateTime;
  /** Canonical timezone keeps recurrence on the intended local calendar across UTC offsets/DST. */
  timezone?: string;
}

export interface LifeAdminItem {
  id: UUID;
  userId: UUID;
  personId?: UUID;
  kind: LifeAdminKind;
  title: string;
  status: LifeAdminStatus;
  importance: 1 | 2 | 3 | 4 | 5;
  dueAt?: ISODateTime;
  startsAt?: ISODateTime;
  endsAt?: ISODateTime;
  recurrence: LifeAdminRecurrence;
  amountMinor?: number;
  currency?: string;
  details: Record<string, unknown>;
  completedAt?: ISODateTime;
  provenance: Provenance;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Preference {
  id: UUID;
  userId: UUID;
  key: string;
  value: unknown;
  provenance: Provenance;
}

export interface Rule {
  id: UUID;
  userId: UUID;
  key: string;
  description: string;
  ruleType: 'boundary' | 'scheduling' | 'continuity' | 'governance' | 'permission' | 'custom';
  config: Record<string, unknown>;
  active: boolean;
  provenance: Provenance;
}

export type RadarType =
  | 'urgent'
  | 'slipping'
  | 'waiting'
  | 'unanswered'
  | 'promised'
  | 'upcoming'
  | 'conflict'
  | 'opportunity'
  | 'recurring';

export interface SourceRef {
  sourceType: SourceType;
  sourceRef?: string;
  label?: string;
}

export interface RadarItem {
  id: UUID;
  userId: UUID;
  type: RadarType;
  headline: string;
  summary: string;
  status: 'open' | 'resolved' | 'dismissed';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  importance: number;
  urgency: number;
  goalAlignment: number;
  consequence: number;
  sourceRefs: SourceRef[];
  reasonCodes: string[];
  relatedGoalId?: UUID;
  relatedProjectId?: UUID;
  relatedCommitmentId?: UUID;
  createdAt: ISODateTime;
  firstRelevantAt: ISODateTime;
  expiresAt?: ISODateTime;
  resolvedAt?: ISODateTime;
  resolution?: string;
}

export interface Evidence {
  id: UUID;
  userId: UUID;
  kind: 'user_completion' | 'external' | 'system';
  summary: string;
  sourceType: SourceType;
  sourceRef?: string;
  relatedGoalId?: UUID;
  relatedCommitmentId?: UUID;
  relatedActionId?: UUID;
  createdAt: ISODateTime;
}

export interface DailyPlanBlock {
  id: UUID;
  title: string;
  startAt?: ISODateTime;
  endAt?: ISODateTime;
  goalId?: UUID;
  actionId?: UUID;
  lifeAdminItemId?: UUID;
  source?: 'methodology' | 'calendar' | 'commitment' | 'routine' | 'life_os';
  /** Calendar blocks: the connected account(s) the event came from (one invite on two calendars is one block). */
  connectionIds?: UUID[];
}

export interface DailyPlan {
  userId: UUID;
  date: string;
  mode: OperatingModeKey;
  numberOneMove?: NextAction;
  morningSequence: string[];
  blocks: DailyPlanBlock[];
  routineIds: UUID[];
  commitmentIds: UUID[];
  approvalActionIds: UUID[];
  radarItemIds: UUID[];
  completionState: 'not_started' | 'in_progress' | 'complete';
  verdict?: 'full_day' | 'mvd' | 'miss';
}

export type IntegrationProvider = 'device' | 'google' | 'microsoft' | 'apple_caldav';
export type IntegrationKind = 'calendar' | 'email';

export interface IntegrationConnection {
  id: UUID;
  userId: UUID;
  provider: IntegrationProvider;
  kind: IntegrationKind;
  accountLabel?: string;
  externalAccountId?: string;
  /** The user's own name for the account ("Work", "Personal"). */
  label?: string;
  /** One primary per kind: kept live on a downgrade, default account for rules. */
  isPrimary?: boolean;
  /** Set when the account is paused (no sync, no actions): today only 'plan' (0065). */
  pausedAt?: ISODateTime;
  pausedReason?: 'plan';
  status: 'connected' | 'needs_reauth' | 'error' | 'disconnected';
  scopes: string[];
  lastSyncAt?: ISODateTime;
  lastErrorCode?: string;
}

export interface CalendarEvent {
  id: UUID;
  userId: UUID;
  connectionId?: UUID;
  provider: string;
  externalEventId: string;
  calendarExternalId?: string;
  title: string;
  location?: string;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  timezone?: string;
  allDay: boolean;
  availability: 'free' | 'busy' | 'tentative' | 'out_of_office';
  recurrence: Record<string, unknown>;
  organizer: Record<string, unknown>;
  attendees: unknown[];
  sourceVersion?: string;
  deleted: boolean;
}

export type MessageSignalType =
  | 'commitment'
  | 'request'
  | 'follow_up'
  | 'waiting_for'
  | 'deadline'
  | 'meeting'
  | 'cancellation'
  | 'completion'
  | 'person';

export interface MessageSignal {
  id: UUID;
  userId: UUID;
  connectionId?: UUID;
  provider: 'google' | 'microsoft';
  externalMessageId: string;
  externalThreadId?: string;
  signalType: MessageSignalType;
  summary: string;
  dueAt?: ISODateTime;
  confidence: number;
  relatedCommitmentId?: UUID;
  userCorrectedAt?: ISODateTime;
  observedAt: ISODateTime;
}

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface Permission {
  id: UUID;
  userId: UUID;
  domain: string;
  actionType: string;
  autonomyLevel: AutonomyLevel;
  constraints: Record<string, unknown>;
  enabled: boolean;
  grantedAt?: ISODateTime;
  updatedAt: ISODateTime;
}

export type ActionStatus =
  | 'proposed'
  | 'prepared'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'verified'
  | 'closed'
  | 'failed'
  | 'cancelled';

export interface ActionRecord {
  id: UUID;
  userId: UUID;
  domain: string;
  actionType: string;
  status: ActionStatus;
  payload: Record<string, unknown>;
  reason: string;
  permissionId?: UUID;
  idempotencyKey: string;
  requiresApproval: boolean;
  approvedAt?: ISODateTime;
  executedAt?: ISODateTime;
  verifiedAt?: ISODateTime;
  failureCode?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface AuditEvent {
  id: UUID;
  userId?: UUID;
  eventType: string;
  actorType: 'user' | 'system' | 'connector' | 'ai';
  actorRef?: string;
  objectType?: string;
  objectId?: string;
  dataClass?: string;
  metadata: Record<string, unknown>;
  createdAt: ISODateTime;
}

/** Day state that feeds the daily-action supplier (BHPC Laws 1, 3 and 6). */
export type DayState = 'normal' | 'recovery' | 'missed_yesterday';

export interface DayRecord {
  id: UUID;
  userId: UUID;
  /** Local calendar day (YYYY-MM-DD) in the user's timezone. */
  day: string;
  mode: OperatingModeKey;
  verdict?: 'full_day' | 'mvd' | 'miss';
  completedActionIds: UUID[];
  note?: string;
  closedAt?: ISODateTime;
  /** Morning check-in mood, 1–10 (BHPC Mood Gate: ≤ 2 runs a Minimum Viable Day). */
  mood?: number;
  dayState?: DayState;
  /** The agenda snapshot printed for the day (frozen once the day is locked). */
  agenda?: Record<string, unknown>;
  agendaStatus?: 'printed' | 'locked';
  checkedInAt?: ISODateTime;
  /** Declared mid-day replans (external change, safety, permission only). */
  replans: Array<{ reason: string; detail?: string; at: ISODateTime }>;
  /** End-of-day close (migration 0022). */
  pillarReview?: Array<{ pillar: PlanPillar; score: 'hit' | 'partial' | 'miss'; completed?: string }>;
  computedVerdict?: 'full_day' | 'mvd' | 'miss';
  carryForward?: string;
  insight?: string;
  /** Phase Bridge: First Hour begun, then the Daily Stack (migration 0027). */
  phase?: 'first_hour' | 'executing';
  /** Return / Reset re-entry acknowledged today. */
  returnedAt?: ISODateTime;
  reprintCount?: number;
}

export interface DiaryEntry {
  id: UUID;
  userId: UUID;
  kind: 'diary' | 'breakthrough' | 'slip';
  body: string;
  localDay: string;
  createdAt: ISODateTime;
}

export interface WeeklyReview {
  id: UUID;
  userId: UUID;
  weekStart: string;
  summary: Record<string, unknown>;
  adjustment?: string;
  completedAt: ISODateTime;
}

export type OsChangeField =
  | 'morning_sequence' | 'coaching_firmness' | 'day_start' | 'coaching_reminder_days' | 'show_seven_day_snapshot'
  | 'review_day' | 'recovery_day' | 'hard_boundaries' | 'non_negotiables' | 'core_values' | 'north_star'
  | 'pillar' | 'tracks' | 'track_settings';

/** BHPC Chat C (the Drafting Room): a change is drafted, then applied explicitly. */
export interface OsChangeRequest {
  id: UUID;
  userId: UUID;
  field: OsChangeField;
  proposed: unknown;
  previous?: unknown;
  reason?: string;
  status: 'draft' | 'applied' | 'discarded';
  createdAt: ISODateTime;
  appliedAt?: ISODateTime;
  effectiveFrom?: string;
}

/** Evidence that one supplied goal-plan action was done on a local day. */
export interface PlanActionCompletion {
  id: UUID;
  userId: UUID;
  planId: UUID;
  day: string;
  actionKey: string;
  instanceId: string;
  scope: 'standard' | 'mvd';
  role: 'foreground' | 'floor';
  note?: string;
  createdAt: ISODateTime;
}

export type GoalPlanStatus = 'active' | 'decided' | 'superseded';
export type GoalPlanDecision = 'promote' | 'maintain' | 'park';

export interface GoalPlanGateReview {
  verdict: GoalPlanDecision;
  stillAligned: boolean;
  completedDays: number;
  evidenceCount: number;
  reviewedAt: ISODateTime;
}

/**
 * A persisted goal → 30/60/90 plan (migration 0021). `plan` is the deterministic
 * engine output from packages/planning (`GoalPlan`), stored verbatim; the row
 * columns carry what the database itself enforces.
 */
export interface StoredGoalPlan<TPlan = Record<string, unknown>> {
  id: UUID;
  userId: UUID;
  goalId: UUID;
  planKey: string;
  templateKey: string;
  persona: string;
  foregroundPillar: PlanPillar;
  startDate: string;
  endDate: string;
  timezone?: string;
  plan: TPlan;
  status: GoalPlanStatus;
  decision?: GoalPlanDecision;
  decisionReason?: string;
  decidedAt?: ISODateTime;
  gateReviews: Partial<Record<'foundation' | 'build' | 'establish', GoalPlanGateReview>>;
  createdAt: ISODateTime;
}

export type AutopilotActionClass =
  | 'calendar.create'
  | 'email.draft'
  | 'email.send'
  | 'calendar.reschedule'
  | 'calendar.decline'
  | 'appointment.book'
  | 'subscription.cancel';

export type AutopilotUndoMethod = 'delete_event' | 'delete_draft' | 'restore_time' | 'reaccept' | 'none';

/**
 * Standing-rule constraints (migrations 0018 + 0033). ISO weekdays: Monday = 1.
 * Each class uses its own subset; the database validates the exact shape.
 */
export interface AutopilotRuleConstraints {
  timezone: string;
  weekdays?: number[];
  windowStart?: string;
  windowEnd?: string;
  maxPerDay: number;
  maxDurationMinutes?: number;
  horizonDays?: number;
  collision?: 'never_overlap_busy';
  allowedRecipientDomains?: string[];
  maxPerRecipientPerDay?: number;
  allowedKinds?: Array<'scheduling_reply' | 'follow_up' | 'confirmation' | 'template'>;
  allowedRecipients?: string[];
  templates?: Array<{ id: string; label: string; subject: string; body: string }>;
  maxShiftDays?: number;
  matchTitleKeywords?: string[];
  maxAttendees?: number;
  protectedTitleKeywords?: string[];
  boundaries?: Array<{ weekdays: number[]; start: string; end: string }>;
  declineNote?: string;
  providers?: Array<{ email: string; label: string; category: string; appointmentTypes: string[] }>;
  allowedProviderDomains?: string[];
}

/** One line of the Autopilot daily done-list (private.apm_autopilot_done_list). */
export interface AutopilotDoneItem {
  kind: 'run' | 'stopped';
  executionId?: UUID;
  actionId?: UUID;
  actionClass: AutopilotActionClass;
  status: AutopilotExecution['status'] | 'needs_you';
  at: ISODateTime;
  summary: string;
  reversible: boolean;
  canUndo: boolean;
  undoLabel: string;
  stoppedReason?: 'payment_required' | 'needs_user';
  failureCode?: string;
}

export interface AutopilotActionClassState {
  actionClass: AutopilotActionClass;
  domain: 'calendar' | 'email' | 'appointment' | 'subscription';
  connectorKind: 'calendar' | 'email';
  actionType: string;
  reversible: boolean;
  undoMethod: AutopilotUndoMethod;
  undoLabel: string;
  activationStatus: 'inactive' | 'active';
  activatedAt?: ISODateTime;
}

export interface AutopilotRule {
  id: UUID;
  userId: UUID;
  actionClass: AutopilotActionClass;
  status: 'active' | 'paused' | 'revoked';
  constraints: AutopilotRuleConstraints;
  /** The connected account the rule acts on (0065); a claim on any other account is refused. */
  connectionId?: UUID;
  version: number;
  grantedAt: ISODateTime;
  expiresAt: ISODateTime;
  pausedAt?: ISODateTime;
  revokedAt?: ISODateTime;
  revokeReason?: string;
  lastExecutedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface AutopilotExecution {
  id: UUID;
  userId: UUID;
  ruleId: UUID;
  ruleVersion: number;
  actionClass: AutopilotActionClass;
  actionId?: UUID;
  /** The connected account this execution acted on; undo goes back to it. */
  connectionId?: UUID;
  status: 'claimed' | 'verified' | 'failed' | 'reverted';
  idempotencyKey: string;
  proposedStartsAt?: ISODateTime;
  proposedEndsAt?: ISODateTime;
  localDay: string;
  externalRef?: string;
  targetRef?: string;
  originalStartsAt?: ISODateTime;
  originalEndsAt?: ISODateTime;
  failureCode?: string;
  claimedAt: ISODateTime;
  completedAt?: ISODateTime;
  revertedAt?: ISODateTime;
}

export interface AutopilotState {
  entitled: boolean;
  masterPaused: boolean;
  classes: AutopilotActionClassState[];
  rules: AutopilotRule[];
  executions: AutopilotExecution[];
}

export interface SubscriptionEntitlement {
  userId: UUID;
  plan: 'beta' | 'chief_of_staff' | 'life_os' | 'autopilot' | 'household';
  status: 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';
  provider?: string;
  currentPeriodEnd?: ISODateTime;
  /** Phase D (migration 0040): written only by the verified RevenueCat webhook. */
  billingPeriod?: 'monthly' | 'annual';
  storeProductId?: string;
  offer?: 'standard' | 'founding';
  cancelAtPeriodEnd?: boolean;
  billingIssueAt?: ISODateTime;
  pendingPlan?: 'chief_of_staff' | 'life_os' | 'autopilot';
}

export interface Household {
  id: UUID;
  createdBy: UUID;
  name: string;
  createdAt: ISODateTime;
}

export interface HouseholdMember {
  householdId: UUID;
  userId: UUID;
  role: 'owner' | 'adult' | 'caregiver' | 'member';
  status: 'active' | 'left' | 'removed';
  joinedAt: ISODateTime;
}

export interface HouseholdItem {
  id: UUID;
  householdId: UUID;
  createdBy: UUID;
  itemType: 'commitment' | 'responsibility' | 'event' | 'goal' | 'note';
  title: string;
  details: Record<string, unknown>;
  assignedUserId?: UUID;
  status: 'open' | 'complete' | 'cancelled';
  dueAt?: ISODateTime;
}

export interface LifeGraphSnapshot {
  identity: UserIdentity;
  roles: Role[];
  pillarSettings: PillarSetting[];
  tracks: Track[];
  modes: OperatingMode[];
  personalOS?: PersonalOS;
  goals: Goal[];
  milestones: Milestone[];
  projects: Project[];
  commitments: Commitment[];
  nextActions: NextAction[];
  routines: Routine[];
  people: Person[];
  lifeRelationships: LifeRelationship[];
  lifeAdminItems: LifeAdminItem[];
  preferences: Preference[];
  rules: Rule[];
  radarItems: RadarItem[];
  evidence: Evidence[];
  connections: IntegrationConnection[];
  calendarEvents: CalendarEvent[];
  messageSignals: MessageSignal[];
  permissions: Permission[];
  actions: ActionRecord[];
  dayRecords: DayRecord[];
  goalPlans: StoredGoalPlan[];
  planCompletions: PlanActionCompletion[];
  diaryEntries: DiaryEntry[];
  weeklyReviews: WeeklyReview[];
  osChanges: OsChangeRequest[];
  entitlement?: SubscriptionEntitlement;
}
