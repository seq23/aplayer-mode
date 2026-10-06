import type { Client } from 'pg';
import type {
  Evidence,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  PillarName,
  Role,
  UserIdentity,
} from '@apm/domain';

export interface OnboardingPayload {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  becoming?: string;
  pillar?: PillarName;
}

const iso = (value: Date | string) => new Date(value).toISOString();

export async function getLifeGraph(client: Client, userId: string): Promise<LifeGraphSnapshot> {
  const profileResult = await client.query<{
    display_name: string;
    timezone: string | null;
    current_season: string | null;
    becoming: string | null;
  }>(
    `select display_name, timezone, current_season, becoming
       from user_profiles
      where user_id = $1`,
    [userId],
  );

  const identity: UserIdentity = {
    userId,
    displayName: profileResult.rows[0]?.display_name ?? '',
    timezone: profileResult.rows[0]?.timezone ?? undefined,
    currentSeason: profileResult.rows[0]?.current_season ?? undefined,
    becoming: profileResult.rows[0]?.becoming ?? undefined,
  };

  const [roleResult, goalResult, actionResult, evidenceResult] = await Promise.all([
    client.query<{
      id: string;
      name: string;
      active: boolean;
      provenance_kind: Role['provenance']['kind'];
      source_type: Role['provenance']['sourceType'];
      source_ref: string | null;
      confidence: number | null;
      created_at: Date | string;
    }>(`select * from roles where user_id = $1 order by created_at asc`, [userId]),
    client.query<{
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
      created_at: Date | string;
    }>(`select * from goals where user_id = $1 order by priority asc, created_at desc`, [userId]),
    client.query<{
      id: string;
      project_id: string | null;
      goal_id: string | null;
      commitment_id: string | null;
      title: string;
      status: NextAction['status'];
      estimated_minutes: number | null;
    }>(`select * from next_actions where user_id = $1 order by created_at desc`, [userId]),
    client.query<{
      id: string;
      kind: Evidence['kind'];
      summary: string;
      source_type: Evidence['sourceType'];
      source_ref: string | null;
      related_goal_id: string | null;
      related_action_id: string | null;
      created_at: Date | string;
    }>(`select * from evidence where user_id = $1 order by created_at desc`, [userId]),
  ]);

  const roles: Role[] = roleResult.rows.map((row) => ({
    id: row.id,
    userId,
    name: row.name,
    active: row.active,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: iso(row.created_at),
    },
  }));

  const goals: Goal[] = goalResult.rows.map((row) => ({
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
      createdAt: iso(row.created_at),
    },
  }));

  const nextActions: NextAction[] = actionResult.rows.map((row) => ({
    id: row.id,
    userId,
    projectId: row.project_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    commitmentId: row.commitment_id ?? undefined,
    title: row.title,
    status: row.status,
    estimatedMinutes: row.estimated_minutes ?? undefined,
  }));

  const evidence: Evidence[] = evidenceResult.rows.map((row) => ({
    id: row.id,
    userId,
    kind: row.kind,
    summary: row.summary,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? undefined,
    relatedGoalId: row.related_goal_id ?? undefined,
    relatedActionId: row.related_action_id ?? undefined,
    createdAt: iso(row.created_at),
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
  client: Client,
  userId: string,
  input: OnboardingPayload,
): Promise<LifeGraphSnapshot> {
  const goalId = crypto.randomUUID();
  const actionId = crypto.randomUUID();

  await client.query('begin');
  try {
    await client.query(
      `insert into app_users (id) values ($1)
       on conflict (id) do update set updated_at = now()`,
      [userId],
    );

    await client.query(
      `insert into user_profiles (user_id, display_name, current_season, becoming)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update set
         display_name = excluded.display_name,
         current_season = excluded.current_season,
         becoming = excluded.becoming,
         updated_at = now()`,
      [userId, input.displayName, input.currentSeason ?? null, input.becoming ?? null],
    );

    await client.query(`delete from roles where user_id = $1`, [userId]);
    for (const roleName of input.roles) {
      await client.query(
        `insert into roles
          (id, user_id, name, active, provenance_kind, source_type, confidence)
         values ($1, $2, $3, true, 'stated', 'manual', 1)`,
        [crypto.randomUUID(), userId, roleName],
      );
    }

    await client.query(`update goals set priority = priority + 1, updated_at = now() where user_id = $1`, [userId]);
    await client.query(
      `insert into goals
        (id, user_id, title, status, health, pillar, priority, provenance_kind, source_type, confidence)
       values ($1, $2, $3, 'active', 'unknown', $4, 1, 'stated', 'manual', 1)`,
      [goalId, userId, input.primaryGoal, input.pillar ?? null],
    );

    await client.query(
      `insert into next_actions
        (id, user_id, goal_id, title, status, estimated_minutes)
       values ($1, $2, $3, $4, 'open', 45)`,
      [actionId, userId, goalId, `Spend 45 focused minutes advancing: ${input.primaryGoal}`],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }

  return getLifeGraph(client, userId);
}

export async function completeNextAction(
  client: Client,
  userId: string,
  actionId: string,
): Promise<{ action: NextAction; evidence: Evidence } | null> {
  await client.query('begin');
  try {
    const actionResult = await client.query<{
      id: string;
      project_id: string | null;
      goal_id: string | null;
      commitment_id: string | null;
      title: string;
      status: NextAction['status'];
      estimated_minutes: number | null;
    }>(
      `select * from next_actions where id = $1 and user_id = $2 for update`,
      [actionId, userId],
    );

    const row = actionResult.rows[0];
    if (!row) {
      await client.query('rollback');
      return null;
    }

    await client.query(
      `update next_actions set status = 'done', updated_at = now() where id = $1 and user_id = $2`,
      [actionId, userId],
    );

    const evidenceId = crypto.randomUUID();
    const evidenceResult = await client.query<{ created_at: Date | string }>(
      `insert into evidence
        (id, user_id, kind, summary, source_type, related_goal_id, related_action_id)
       values ($1, $2, 'user_completion', $3, 'manual', $4, $5)
       returning created_at`,
      [evidenceId, userId, `User marked complete: ${row.title}`, row.goal_id, row.id],
    );

    await client.query('commit');

    return {
      action: {
        id: row.id,
        userId,
        projectId: row.project_id ?? undefined,
        goalId: row.goal_id ?? undefined,
        commitmentId: row.commitment_id ?? undefined,
        title: row.title,
        status: 'done',
        estimatedMinutes: row.estimated_minutes ?? undefined,
      },
      evidence: {
        id: evidenceId,
        userId,
        kind: 'user_completion',
        summary: `User marked complete: ${row.title}`,
        sourceType: 'manual',
        relatedGoalId: row.goal_id ?? undefined,
        relatedActionId: row.id,
        createdAt: iso(evidenceResult.rows[0]?.created_at ?? new Date()),
      },
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
