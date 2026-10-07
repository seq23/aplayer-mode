import type {
  AccountabilityPolicy,
  CoachingStyle,
  Evidence,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  OperatingMode,
  OperatingModeKey,
  PersonalOS,
  PillarName,
  PillarSetting,
  Role,
  Track,
  ActiveTrackKey,
  UserIdentity,
  WeeklyCadence,
} from '@apm/domain';
import type { ApiEnv } from './env';
import { TRACK_LIBRARY } from './coach/tracks';
import { supabaseRest } from './db';
import { planHasCapability } from '@apm/policy';
import { getPlatformState } from './platformRepository';

export interface OnboardingPayload {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
}

export interface MethodologyIntakePayload extends OnboardingPayload {
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
  schedulingPreference?: PersonalOS['schedulingPreference'];
  hardBoundaries?: string[];
  scoringConfig?: PersonalOS['scoringConfig'];
  foregroundProjectName?: string;
  foregroundProjectObjective?: string;
  reviewGateDays?: 30 | 60 | 90;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  timezone: string | null;
  current_season: string | null;
  becoming: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  active: boolean;
  provenance_kind: Role['provenance']['kind'];
  source_type: Role['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
}

interface GoalRow {
  id: string;
  title: string;
  outcome: string | null;
  status: Goal['status'];
  health: Goal['health'];
  pillar: PillarName | null;
  target_date: string | null;
  priority: number;
  provenance_kind: Goal['provenance']['kind'];
  source_type: Goal['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
}

interface NextActionRow {
  id: string;
  project_id: string | null;
  goal_id: string | null;
  commitment_id: string | null;
  title: string;
  status: NextAction['status'];
  estimated_minutes: number | null;
}

interface EvidenceRow {
  id: string;
  kind: Evidence['kind'];
  summary: string;
  source_type: Evidence['sourceType'];
  source_ref: string | null;
  related_goal_id: string | null;
  related_commitment_id: string | null;
  related_action_id: string | null;
  created_at: string;
}

interface PersonalOSRow {
  user_id: string;
  north_star: string | null;
  core_values: string[];
  non_negotiables: string[];
  failure_patterns: string[];
  body_context: string | null;
  work_money_context: string | null;
  mind_spirit_learning_context: string | null;
  weekly_cadence: WeeklyCadence;
  coaching_style: CoachingStyle;
  accountability: AccountabilityPolicy;
  active_mode: OperatingModeKey;
  foreground_goal_id: string | null;
  morning_sequence: string[];
  scheduling_preference: PersonalOS['schedulingPreference'];
  hard_boundaries: string[];
  scoring_config: PersonalOS['scoringConfig'];
  stabilization_started_at: string | null;
  installed_at: string;
  updated_at: string;
}

interface PillarSettingRow {
  name: PillarName;
  active: boolean;
  critical: boolean;
  minimum_floor: string | null;
}

interface TrackRow {
  id: string;
  key: ActiveTrackKey;
  name: string;
  active: boolean;
  foreground: boolean;
  provenance_kind: Track['provenance']['kind'];
  source_type: Track['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
}

interface ModeRow {
  id: string;
  key: OperatingModeKey;
  name: string;
  active: boolean;
  provenance_kind: OperatingMode['provenance']['kind'];
  source_type: OperatingMode['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
}

const qs = (value: string) => encodeURIComponent(value);

export async function getLifeGraph(
  env: ApiEnv,
  accessToken: string,
  userId: string,
): Promise<LifeGraphSnapshot> {
  const filter = `user_id=eq.${qs(userId)}`;

  const [
    profiles,
    roleRows,
    goalRows,
    actionRows,
    evidenceRows,
    personalOSRows,
    pillarRows,
    trackRows,
    modeRows,
    platform,
  ] = await Promise.all([
    supabaseRest<ProfileRow[]>(env, accessToken, `/rest/v1/user_profiles?${filter}&select=user_id,display_name,timezone,current_season,becoming&limit=1`),
    supabaseRest<RoleRow[]>(env, accessToken, `/rest/v1/roles?${filter}&select=*&order=created_at.asc`),
    supabaseRest<GoalRow[]>(env, accessToken, `/rest/v1/goals?${filter}&select=*&order=priority.asc,created_at.desc`),
    supabaseRest<NextActionRow[]>(env, accessToken, `/rest/v1/next_actions?${filter}&select=*&order=created_at.desc`),
    supabaseRest<EvidenceRow[]>(env, accessToken, `/rest/v1/evidence?${filter}&select=*&order=created_at.desc`),
    supabaseRest<PersonalOSRow[]>(env, accessToken, `/rest/v1/personal_os?${filter}&select=*&limit=1`),
    supabaseRest<PillarSettingRow[]>(env, accessToken, `/rest/v1/pillar_settings?${filter}&select=*&order=name.asc`),
    supabaseRest<TrackRow[]>(env, accessToken, `/rest/v1/tracks?${filter}&select=*&order=created_at.asc`),
    supabaseRest<ModeRow[]>(env, accessToken, `/rest/v1/operating_modes?${filter}&select=*&order=created_at.asc`),
    getPlatformState(env, accessToken, userId),
  ]);

  const profile = profiles[0];
  const identity: UserIdentity = {
    userId,
    displayName: profile?.display_name ?? '',
    timezone: profile?.timezone ?? undefined,
    currentSeason: profile?.current_season ?? undefined,
    becoming: profile?.becoming ?? undefined,
  };

  const roles: Role[] = roleRows.map((row) => ({
    id: row.id,
    userId,
    name: row.name,
    active: row.active,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    },
  }));

  const goals: Goal[] = goalRows.map((row) => ({
    id: row.id,
    userId,
    title: row.title,
    outcome: row.outcome ?? undefined,
    status: row.status,
    health: row.health,
    pillar: row.pillar ?? undefined,
    targetDate: row.target_date ?? undefined,
    priority: row.priority,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    },
  }));

  const nextActions: NextAction[] = actionRows.map((row) => ({
    id: row.id,
    userId,
    projectId: row.project_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    commitmentId: row.commitment_id ?? undefined,
    title: row.title,
    status: row.status,
    estimatedMinutes: row.estimated_minutes ?? undefined,
  }));

  const evidence: Evidence[] = evidenceRows.map((row) => ({
    id: row.id,
    userId,
    kind: row.kind,
    summary: row.summary,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? undefined,
    relatedGoalId: row.related_goal_id ?? undefined,
    relatedCommitmentId: row.related_commitment_id ?? undefined,
    relatedActionId: row.related_action_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  const pillarSettings: PillarSetting[] = pillarRows.map((row) => ({
    userId,
    name: row.name,
    active: row.active,
    critical: row.critical,
    minimumFloor: row.minimum_floor ?? undefined,
  }));

  const tracks: Track[] = trackRows.map((row) => ({
    id: row.id,
    userId,
    key: row.key,
    name: row.name,
    active: row.active,
    foreground: row.foreground,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    },
  }));

  const modes: OperatingMode[] = modeRows.map((row) => ({
    id: row.id,
    userId,
    key: row.key,
    name: row.name,
    active: row.active,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    },
  }));

  const lifeOsEnabled = Boolean(
    platform.entitlement
    && (platform.entitlement.status === 'active' || platform.entitlement.status === 'trialing')
    && platform.entitlement.plan !== 'household'
    && planHasCapability(platform.entitlement.plan, 'life_os_domains'),
  );

  const osRow = personalOSRows[0];
  const personalOS: PersonalOS | undefined = osRow
    ? {
        userId,
        northStar: osRow.north_star ?? undefined,
        values: osRow.core_values ?? [],
        nonNegotiables: osRow.non_negotiables ?? [],
        failurePatterns: osRow.failure_patterns ?? [],
        bodyContext: osRow.body_context ?? undefined,
        workMoneyContext: osRow.work_money_context ?? undefined,
        mindSpiritLearningContext: osRow.mind_spirit_learning_context ?? undefined,
        weeklyCadence: osRow.weekly_cadence ?? { heavyDays: [], lightDays: [] },
        coachingStyle: osRow.coaching_style ?? { firmness: 'direct' },
        accountability: osRow.accountability ?? { dayStart: 'guided' },
        activeMode: osRow.active_mode,
        foregroundGoalId: osRow.foreground_goal_id ?? undefined,
        morningSequence: osRow.morning_sequence ?? [],
        schedulingPreference: osRow.scheduling_preference ?? 'ordered_stack',
        hardBoundaries: osRow.hard_boundaries ?? [],
        scoringConfig: osRow.scoring_config ?? { enabled: true, showSevenDaySnapshot: true },
        stabilizationStartedAt: osRow.stabilization_started_at ?? undefined,
        installedAt: new Date(osRow.installed_at).toISOString(),
        updatedAt: new Date(osRow.updated_at).toISOString(),
      }
    : undefined;

  return {
    identity,
    roles,
    pillarSettings,
    tracks,
    modes,
    personalOS,
    goals,
    milestones: platform.milestones,
    projects: platform.projects,
    commitments: platform.commitments,
    nextActions,
    routines: platform.routines,
    people: platform.people,
    lifeRelationships: lifeOsEnabled ? platform.lifeRelationships : [],
    lifeAdminItems: lifeOsEnabled ? platform.lifeAdminItems : [],
    preferences: platform.preferences,
    rules: platform.rules,
    radarItems: [],
    evidence,
    connections: platform.connections,
    calendarEvents: platform.calendarEvents,
    messageSignals: platform.messageSignals,
    permissions: platform.permissions,
    actions: platform.actions,
    dayRecords: platform.dayRecords,
    goalPlans: platform.goalPlans,
    planCompletions: platform.planCompletions,
    entitlement: platform.entitlement,
  };
}

export async function saveOnboarding(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: OnboardingPayload,
): Promise<LifeGraphSnapshot> {
  await supabaseRest<void>(env, accessToken, '/rest/v1/rpc/apm_save_onboarding', {
    method: 'POST',
    body: JSON.stringify({
      p_display_name: input.displayName,
      p_roles: input.roles,
      p_primary_goal: input.primaryGoal,
      p_current_season: input.currentSeason ?? null,
      p_becoming: input.becoming ?? null,
      p_pillar: input.pillar ?? null,
    }),
  });
  return getLifeGraph(env, accessToken, userId);
}

/** Track keys the 0004 intake RPC still inserts itself; every other Track is upserted after it (see below). */
const intakeRpcTrackKeys = new Set<ActiveTrackKey>([
  'billionaire_mindset',
  'operator_discipline',
  'strategic_patience',
]);
const legacyModeKeys = new Set<OperatingModeKey>(['standard', 'recovery', 'high_pressure', 'executive_review']);

export async function saveMethodologyIntake(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: MethodologyIntakePayload,
): Promise<LifeGraphSnapshot> {
  const legacyMode = input.activeMode && legacyModeKeys.has(input.activeMode) ? input.activeMode : 'standard';
  const legacyTracks = input.trackKeys.filter((key) => intakeRpcTrackKeys.has(key));

  await supabaseRest<void>(env, accessToken, '/rest/v1/rpc/apm_save_methodology_intake', {
    method: 'POST',
    body: JSON.stringify({
      p_payload: {
        display_name: input.displayName,
        roles: input.roles,
        primary_goal: input.primaryGoal,
        goal_outcome: input.goalOutcome ?? null,
        goal_target_date: input.goalTargetDate ?? null,
        current_season: input.currentSeason ?? null,
        becoming: input.becoming ?? null,
        timezone: input.timezone ?? null,
        pillar: input.pillar ?? null,
        first_next_action: input.firstNextAction ?? null,
        north_star: input.northStar ?? null,
        values: input.values,
        non_negotiables: input.nonNegotiables,
        failure_patterns: input.failurePatterns,
        body_context: input.bodyContext ?? null,
        work_money_context: input.workMoneyContext ?? null,
        mind_spirit_learning_context: input.mindSpiritLearningContext ?? null,
        weekly_cadence: input.weeklyCadence,
        coaching_style: input.coachingStyle,
        accountability: input.accountability,
        critical_pillars: input.criticalPillars,
        minimum_floors: input.minimumFloors,
        track_keys: legacyTracks,
        active_mode: legacyMode,
      },
    }),
  });

  await supabaseRest(env, accessToken, `/rest/v1/personal_os?user_id=eq.${qs(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      morning_sequence: (input.morningSequence ?? []).slice(0, 5),
      scheduling_preference: input.schedulingPreference ?? 'ordered_stack',
      hard_boundaries: input.hardBoundaries ?? [],
      scoring_config: input.scoringConfig ?? { enabled: true, showSevenDaySnapshot: true },
      active_mode: input.activeMode ?? legacyMode,
      updated_at: new Date().toISOString(),
    }),
  });

  // The intake RPC replaces the user's Track set and only knows the original
  // three keys; Resilience and the app-only Tracks are upserted here so the
  // final set is exactly what the user chose.
  const upsertTracks = input.trackKeys.filter((key) => !intakeRpcTrackKeys.has(key));
  if (upsertTracks.length) {
    await supabaseRest(env, accessToken, '/rest/v1/tracks?on_conflict=user_id,key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(upsertTracks.map((key) => ({ user_id: userId, key, name: TRACK_LIBRARY[key].name, active: true, foreground: false, provenance_kind: 'stated', source_type: 'manual', confidence: 1 }))),
    });
  }

  const modeNames: Record<OperatingModeKey, string> = {
    standard: 'Standard', recovery: 'Recovery', high_pressure: 'High-Pressure Coaching', executive_review: 'Executive Review', sprint: 'Sprint', deep_work: 'Deep Work',
  };
  await supabaseRest(env, accessToken, '/rest/v1/operating_modes?on_conflict=user_id,key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify((Object.keys(modeNames) as OperatingModeKey[]).map((key) => ({ user_id: userId, key, name: modeNames[key], active: key === (input.activeMode ?? legacyMode), provenance_kind: 'system', source_type: 'system', confidence: 1 }))),
  });

  const graphAfterBase = await getLifeGraph(env, accessToken, userId);
  const foregroundGoal = graphAfterBase.goals.find((goal) => goal.priority === 1 && goal.status === 'active');
  if (foregroundGoal) {
    await supabaseRest(env, accessToken, `/rest/v1/projects?user_id=eq.${qs(userId)}&foreground=eq.true`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ foreground: false, updated_at: new Date().toISOString() }),
    });
    await supabaseRest(env, accessToken, '/rest/v1/projects?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{
        user_id: userId,
        goal_id: foregroundGoal.id,
        title: input.foregroundProjectName ?? foregroundGoal.title,
        objective: input.foregroundProjectObjective ?? foregroundGoal.outcome ?? foregroundGoal.title,
        status: 'active',
        foreground: true,
        review_gate_days: input.reviewGateDays ?? 30,
        review_gate_at: new Date(Date.now() + (input.reviewGateDays ?? 30) * 86_400_000).toISOString().slice(0, 10),
      }]),
    });
  }

  return getLifeGraph(env, accessToken, userId);
}

export async function setOperatingMode(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  mode: OperatingModeKey,
): Promise<LifeGraphSnapshot> {
  await supabaseRest<void>(env, accessToken, '/rest/v1/rpc/apm_set_operating_mode', {
    method: 'POST',
    body: JSON.stringify({ p_mode: mode }),
  });
  return getLifeGraph(env, accessToken, userId);
}

export async function completeNextAction(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  actionId: string,
): Promise<{ action: NextAction; evidence: Evidence } | null> {
  const result = await supabaseRest<{ action: NextActionRow; evidence: EvidenceRow } | null>(
    env,
    accessToken,
    '/rest/v1/rpc/apm_complete_next_action',
    { method: 'POST', body: JSON.stringify({ p_action_id: actionId }) },
  );
  if (!result) return null;
  return {
    action: {
      id: result.action.id,
      userId,
      projectId: result.action.project_id ?? undefined,
      goalId: result.action.goal_id ?? undefined,
      commitmentId: result.action.commitment_id ?? undefined,
      title: result.action.title,
      status: result.action.status,
      estimatedMinutes: result.action.estimated_minutes ?? undefined,
    },
    evidence: {
      id: result.evidence.id,
      userId,
      kind: result.evidence.kind,
      summary: result.evidence.summary,
      sourceType: result.evidence.source_type,
      sourceRef: result.evidence.source_ref ?? undefined,
      relatedGoalId: result.evidence.related_goal_id ?? undefined,
      relatedCommitmentId: result.evidence.related_commitment_id ?? undefined,
      relatedActionId: result.evidence.related_action_id ?? undefined,
      createdAt: new Date(result.evidence.created_at).toISOString(),
    },
  };
}
