export type UUID = string;
export type ISODateTime = string;

export type ProvenanceKind = 'stated' | 'observed' | 'inferred' | 'imported';
export type SourceType = 'conversation' | 'gmail' | 'calendar' | 'manual' | 'system';

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
  | 'investor_ai_leverage';

export interface Track {
  id: UUID;
  userId: UUID;
  key: TrackKey;
  name: string;
  active: boolean;
  foreground: boolean;
  provenance: Provenance;
}

export type OperatingModeKey = 'standard' | 'recovery' | 'high_pressure' | 'executive_review';

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
  title: string;
  status: 'open' | 'complete' | 'missed';
  dueAt?: ISODateTime;
}

export interface Project {
  id: UUID;
  userId: UUID;
  goalId?: UUID;
  title: string;
  status: 'active' | 'paused' | 'complete';
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
  active: boolean;
  provenance: Provenance;
}

export interface Person {
  id: UUID;
  userId: UUID;
  name: string;
  relationship?: string;
  provenance: Provenance;
}

export interface Preference {
  id: UUID;
  userId: UUID;
  key: string;
  value: string | number | boolean;
  provenance: Provenance;
}

export interface Rule {
  id: UUID;
  userId: UUID;
  key: string;
  description: string;
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
}

export interface DailyPlan {
  userId: UUID;
  date: string;
  mode: OperatingModeKey;
  numberOneMove?: NextAction;
  blocks: DailyPlanBlock[];
  routineIds: UUID[];
  commitmentIds: UUID[];
  approvalActionIds: UUID[];
  radarItemIds: UUID[];
  completionState: 'not_started' | 'in_progress' | 'complete';
  verdict?: 'full_day' | 'mvd' | 'miss';
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
  preferences: Preference[];
  rules: Rule[];
  radarItems: RadarItem[];
  evidence: Evidence[];
}
