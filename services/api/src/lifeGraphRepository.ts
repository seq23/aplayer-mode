import type {
  Evidence,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  PillarName,
  Role,
  UserIdentity,
} from '@apm/domain';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';

export interface OnboardingPayload {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
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

interface ActionRow {
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
  related_action_id: string | null;
  created_at: string;
}

const qs = (value: string) => encodeURIComponent(value);

export async function getLifeGraph(
  env: ApiEnv,
  accessToken: string,
  userId: string,
): Promise<LifeGraphSnapshot> {
  const filter = `user_id=eq.${qs(userId)}`;

  const [profiles, roleRows, goalRows, actionRows, evidenceRows] = await Promise.all([
    supabaseRest<ProfileRow[]>(
      env,
      accessToken,
      `/rest/v1/user_profiles?${filter}&select=user_id,display_name,timezone,current_season,becoming&limit=1`,
    ),
    supabaseRest<RoleRow[]>(
      env,
      accessToken,
      `/rest/v1/roles?${filter}&select=*&order=created_at.asc`,
    ),
    supabaseRest<GoalRow[]>(
      env,
      accessToken,
      `/rest/v1/goals?${filter}&select=*&order=priority.asc,created_at.desc`,
    ),
    supabaseRest<ActionRow[]>(
      env,
      accessToken,
      `/rest/v1/next_actions?${filter}&select=*&order=created_at.desc`,
    ),
    supabaseRest<EvidenceRow[]>(
      env,
      accessToken,
      `/rest/v1/evidence?${filter}&select=*&order=created_at.desc`,
    ),
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
    relatedActionId: row.related_action_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return {
    identity,
    roles,
    goals,
    milestones: [],
    projects: [],
    commitments: [],
    nextActions,
    routines: [],
    people: [],
    preferences: [],
    rules: [],
    radarItems: [],
    evidence,
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

export async function completeNextAction(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  actionId: string,
): Promise<{ action: NextAction; evidence: Evidence } | null> {
  const result = await supabaseRest<{ action: ActionRow; evidence: EvidenceRow } | null>(
    env,
    accessToken,
    '/rest/v1/rpc/apm_complete_next_action',
    {
      method: 'POST',
      body: JSON.stringify({ p_action_id: actionId }),
    },
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
      relatedActionId: result.evidence.related_action_id ?? undefined,
      createdAt: new Date(result.evidence.created_at).toISOString(),
    },
  };
}
