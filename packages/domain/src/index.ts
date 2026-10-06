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

export type PillarName = 'wealth' | 'body' | 'spirit' | 'execution';

export interface PillarSetting {
  userId: UUID;
  name: PillarName;
  active: boolean;
  critical: boolean;
  minimumFloor?: string;
}

export type TrackKey =
  | 'billionaire_mindset'
  | 'operator_discipline'
  | 'strategic_patience'
  | 'manifestation_mastery'
  | 'investor_ai_leverage'
  | 'resilience';

export interface Track {
  id: UUID;
  userId: UUID;
  key: TrackKey;
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
  pillar?: PillarName;
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
  pillar?: PillarName;
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

export interface DayRecord {
  id: UUID;
  userId: UUID;
  day: string;
  mode: OperatingModeKey;
  verdict?: 'full_day' | 'mvd' | 'miss';
  completedActionIds: UUID[];
  note?: string;
  closedAt?: ISODateTime;
}

export interface SubscriptionEntitlement {
  userId: UUID;
  plan: 'beta' | 'chief_of_staff' | 'life_os' | 'autopilot' | 'household';
  status: 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';
  provider?: string;
  currentPeriodEnd?: ISODateTime;
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
  entitlement?: SubscriptionEntitlement;
}
