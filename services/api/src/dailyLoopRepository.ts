import type { DayRecord, GoalPlanDecision, PlanActionCompletion, StoredGoalPlan } from '@apm/domain';
import type { DailyAgenda, GoalPlan } from '@apm/planning';
import type { ApiEnv } from './env';
import { SERVICE_ROLE_TOKEN, SupabaseRestError, supabaseRest } from './db';

const qs = (value: string) => encodeURIComponent(value);

/**
 * Goal plans, plan-action completions and day records are written ONLY through the
 * governed RPCs of migration 0021. Direct table writes are revoked, so the database
 * enforces ownership, entitlement, the user's local day, the opening step and the
 * audit trail even if a client skips this Worker.
 */
export class LoopError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'LoopError';
  }
}

const LOOP_ERRORS: Record<string, { error: string; status: 400 | 403 | 404 | 409 | 503; message: string }> = {
  loop_service_unavailable: { error: 'service_unavailable', status: 503, message: 'The daily loop is not configured on this server (SUPABASE_SECRET_KEY is missing).' },
  loop_unauthenticated: { error: 'unauthorized', status: 403, message: 'Sign in again.' },
  loop_entitlement_required: { error: 'entitlement_required', status: 403, message: 'Your plan does not include the daily loop right now.' },
  loop_invalid_request: { error: 'invalid_request', status: 400, message: 'That request is not valid.' },
  loop_field_not_allowed: { error: 'invalid_request', status: 400, message: 'That field cannot be set here.' },
  loop_invalid_plan: { error: 'invalid_plan', status: 400, message: 'The plan failed validation.' },
  loop_invalid_agenda: { error: 'invalid_agenda', status: 400, message: 'The agenda failed validation.' },
  loop_goal_not_found: { error: 'not_found', status: 404, message: 'Goal not found.' },
  loop_plan_not_found: { error: 'not_found', status: 404, message: 'Plan not found.' },
  loop_personal_os_missing: { error: 'personal_os_missing', status: 409, message: 'Complete the Personal OS intake first.' },
  loop_week_one_lock: { error: 'week_one_lock', status: 409, message: 'Week 1 is installation: no new projects and no customising until day 8. One foreground only.' },
  loop_day_not_today: { error: 'day_closed', status: 409, message: 'Only today can be changed. Prior days are closed forever.' },
  loop_day_closed: { error: 'day_closed', status: 409, message: 'Today is already closed.' },
  loop_day_not_locked: { error: 'opening_step_required', status: 409, message: 'Check in first; the agenda is locked at check-in.' },
  loop_opening_step_required: { error: 'opening_step_required', status: 409, message: 'Execution starts after the opening step: check in first.' },
  loop_not_on_agenda: { error: 'not_on_agenda', status: 409, message: 'That action is not on today’s agenda.' },
  loop_no_midday_negotiation: { error: 'no_midday_negotiation', status: 409, message: 'The morning plan stands.' },
  loop_replan_limit: { error: 'replan_limit', status: 409, message: 'Today has already been replanned three times.' },
  loop_gate_not_reached: { error: 'gate_not_reached', status: 409, message: 'This gate has not been reached yet.' },
  loop_decision_not_due: { error: 'decision_not_due', status: 409, message: 'The day-90 decision is not due yet.' },
  loop_goal_parked: { error: 'goal_parked', status: 409, message: 'This goal was parked at its day-90 decision; parked goals stay in the background.' },
  loop_verdict_needs_evidence: { error: 'verdict_needs_evidence', status: 409, message: 'A Full Day or MVD needs at least one completed action today. Otherwise close it as a Miss — a miss is data.' },
  loop_body_referral_active: { error: 'body_referral_active', status: 409, message: 'Body coaching is paused until you record clinician clearance.' },
  loop_no_referral: { error: 'no_referral', status: 409, message: 'There is no body red-flag pause to clear.' },
  loop_change_not_found: { error: 'not_found', status: 404, message: 'Change not found.' },
  loop_change_not_draft: { error: 'change_not_draft', status: 409, message: 'This change was already applied or discarded.' },
  loop_reprint_limit: { error: 'reprint_limit', status: 409, message: 'Today has already been reprinted five times.' },
  loop_already_decided: { error: 'already_decided', status: 409, message: 'This plan already has its day-90 decision.' },
  loop_first_hour_not_started: { error: 'first_hour_not_started', status: 409, message: 'Begin your First Hour first: it starts on your word.' },
  loop_stack_not_open: { error: 'stack_not_open', status: 409, message: 'The Daily Stack opens after the First Hour. Finish or close your First Hour first.' },
  loop_plan_restart_refused: { error: 'plan_restart_refused', status: 409, message: 'A rebuild keeps the plan’s 90 days; it never restarts them.' },
};

export function loopErrorResponse(error: unknown): { error: string; status: 400 | 403 | 404 | 409 | 503; message: string } | undefined {
  return error instanceof LoopError ? LOOP_ERRORS[error.code] ?? { error: error.code, status: 409, message: error.code } : undefined;
}

/** Maps a raw Supabase error whose message is a `loop_*` code (e.g. from a legacy RPC) to a LoopError. */
export function asLoopError(error: unknown): unknown {
  const message = error instanceof SupabaseRestError
    && error.body && typeof error.body === 'object'
    && typeof (error.body as { message?: unknown }).message === 'string'
    ? (error.body as { message: string }).message
    : undefined;
  return message && /^loop_[a-z_]+$/.test(message) ? new LoopError(message) : error;
}

export async function loopRpc<T>(env: ApiEnv, accessToken: string, fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await supabaseRest<T>(env, accessToken, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  } catch (error) {
    const message = error instanceof SupabaseRestError
      && error.body && typeof error.body === 'object'
      && typeof (error.body as { message?: unknown }).message === 'string'
      ? (error.body as { message: string }).message
      : undefined;
    if (message && /^loop_[a-z_]+$/.test(message)) throw new LoopError(message);
    throw error;
  }
}

// ---------------------------------------------------------------- row mapping
export interface GoalPlanRow {
  id: string; user_id: string; goal_id: string; plan_key: string; template_key: string; persona: string;
  foreground_pillar: StoredGoalPlan['foregroundPillar']; start_date: string; end_date: string; timezone: string | null;
  plan: GoalPlan; status: StoredGoalPlan['status']; decision: GoalPlanDecision | null; decision_reason: string | null;
  decided_at: string | null; gate_reviews: StoredGoalPlan['gateReviews'] | null; created_at: string;
}

export interface CompletionRow {
  id: string; user_id: string; plan_id: string; day: string; action_key: string; instance_id: string;
  scope: 'standard' | 'mvd'; role: 'foreground' | 'floor'; note: string | null; created_at: string;
}

export interface DayRow {
  id: string; day: string; mode: DayRecord['mode']; verdict: DayRecord['verdict'] | null; completed_action_ids: string[] | null;
  note: string | null; closed_at: string | null; mood?: number | null; day_state?: DayRecord['dayState'] | null;
  agenda?: Record<string, unknown> | null; agenda_status?: DayRecord['agendaStatus'] | null; checked_in_at?: string | null;
  replans?: DayRecord['replans'] | null;
  phase?: DayRecord['phase'] | null; returned_at?: string | null; reprint_count?: number | null;
  pillar_review?: DayRecord['pillarReview'] | null; computed_verdict?: DayRecord['computedVerdict'] | null;
  carry_forward?: string | null; insight?: string | null;
}

export function mapGoalPlan(row: GoalPlanRow): StoredGoalPlan<GoalPlan> {
  return {
    id: row.id,
    userId: row.user_id,
    goalId: row.goal_id,
    planKey: row.plan_key,
    templateKey: row.template_key,
    persona: row.persona,
    foregroundPillar: row.foreground_pillar,
    startDate: row.start_date,
    endDate: row.end_date,
    ...(row.timezone ? { timezone: row.timezone } : {}),
    plan: row.plan,
    status: row.status,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    gateReviews: row.gate_reviews ?? {},
    createdAt: row.created_at,
  };
}

export function mapCompletion(row: CompletionRow): PlanActionCompletion {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    day: row.day,
    actionKey: row.action_key,
    instanceId: row.instance_id,
    scope: row.scope,
    role: row.role,
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
  };
}

export function mapDayRecord(row: DayRow, userId: string): DayRecord {
  return {
    id: row.id,
    userId,
    day: row.day,
    mode: row.mode,
    verdict: row.verdict ?? undefined,
    completedActionIds: row.completed_action_ids ?? [],
    note: row.note ?? undefined,
    closedAt: row.closed_at ?? undefined,
    ...(row.mood != null ? { mood: row.mood } : {}),
    ...(row.day_state ? { dayState: row.day_state } : {}),
    ...(row.agenda ? { agenda: row.agenda } : {}),
    ...(row.agenda_status ? { agendaStatus: row.agenda_status } : {}),
    ...(row.checked_in_at ? { checkedInAt: row.checked_in_at } : {}),
    replans: row.replans ?? [],
    ...(row.pillar_review ? { pillarReview: row.pillar_review } : {}),
    ...(row.computed_verdict ? { computedVerdict: row.computed_verdict } : {}),
    ...(row.carry_forward ? { carryForward: row.carry_forward } : {}),
    ...(row.insight ? { insight: row.insight } : {}),
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.returned_at ? { returnedAt: row.returned_at } : {}),
    ...(row.reprint_count ? { reprintCount: row.reprint_count } : {}),
  };
}

// ---------------------------------------------------------------- reads
export async function getGoalPlans(env: ApiEnv, accessToken: string, userId: string): Promise<Array<StoredGoalPlan<GoalPlan>>> {
  const rows = await supabaseRest<GoalPlanRow[]>(env, accessToken, `/rest/v1/goal_plans?user_id=eq.${qs(userId)}&status=neq.superseded&select=*&order=created_at.asc`);
  return rows.map(mapGoalPlan);
}

export async function getPlanCompletions(env: ApiEnv, accessToken: string, userId: string, sinceDay: string): Promise<PlanActionCompletion[]> {
  const rows = await supabaseRest<CompletionRow[]>(env, accessToken, `/rest/v1/plan_action_completions?user_id=eq.${qs(userId)}&day=gte.${qs(sinceDay)}&select=*&order=day.asc,created_at.asc`);
  return rows.map(mapCompletion);
}

// ---------------------------------------------------------------- governed writes
/**
 * Agenda-locking writes (check-in, declared replan) are service-role only since 0028: the
 * Worker has authenticated the user and computed the agenda with the deterministic engine,
 * so no client can lock an agenda of its own making.
 */
function serviceToken(env: ApiEnv): string {
  if (!env.SUPABASE_SECRET_KEY) throw new LoopError('loop_service_unavailable');
  return SERVICE_ROLE_TOKEN;
}

/** Plans are server-derived (0029): only the Worker, with the engine's output, writes them. */
export function saveGoalPlan(env: ApiEnv, userId: string, goalId: string, plan: GoalPlan, source: 'intake' | 'goals' | 'backfill' | 'clearance' | 'referral' | 'os_change') {
  return loopRpc<GoalPlanRow>(env, serviceToken(env), 'apm_service_save_goal_plan', { p_user_id: userId, p_goal_id: goalId, p_plan: plan, p_source: source });
}

export function createGoalWithPlan(env: ApiEnv, userId: string, goal: { title: string; outcome?: string; pillar?: string; targetDate?: string }, plan: GoalPlan) {
  return loopRpc<{ goal: { id: string }; plan: GoalPlanRow }>(env, serviceToken(env), 'apm_service_create_goal', { p_user_id: userId, p_goal: goal, p_plan: plan });
}

export function setForegroundGoal(env: ApiEnv, accessToken: string, goalId: string) {
  return loopRpc<{ foregroundGoalId: string; changed: boolean }>(env, accessToken, 'apm_set_foreground_goal', { p_goal_id: goalId });
}

export function checkInDay(env: ApiEnv, userId: string, input: { day: string; mood: number; agenda: DailyAgenda }) {
  return loopRpc<{ day: DayRow; replayed: boolean }>(env, serviceToken(env), 'apm_service_day_check_in', { p_user_id: userId, p_day: input.day, p_mood: input.mood, p_state: input.agenda.state, p_agenda: input.agenda });
}

export function replanDay(env: ApiEnv, userId: string, input: { day: string; reason: string; detail?: string; agenda: DailyAgenda }) {
  return loopRpc<DayRow>(env, serviceToken(env), 'apm_service_day_replan', { p_user_id: userId, p_day: input.day, p_reason: input.reason, p_detail: input.detail ?? null, p_agenda: input.agenda });
}

export function completePlanAction(env: ApiEnv, accessToken: string, input: { planId: string; actionKey: string; note?: string }) {
  return loopRpc<{ completion: CompletionRow; replayed: boolean }>(env, accessToken, 'apm_complete_plan_action', { p_plan_id: input.planId, p_action_key: input.actionKey, p_note: input.note ?? null });
}

export function reviewGoalPlanGate(env: ApiEnv, accessToken: string, input: { planId: string; gate: 'foundation' | 'build'; stillAligned: boolean }) {
  return loopRpc<GoalPlanRow>(env, accessToken, 'apm_review_plan_gate', { p_plan_id: input.planId, p_gate: input.gate, p_still_aligned: input.stillAligned });
}

export function decideGoalPlan(env: ApiEnv, accessToken: string, input: { planId: string; decision: GoalPlanDecision; reason: string }) {
  return loopRpc<GoalPlanRow>(env, accessToken, 'apm_decide_goal_plan', { p_plan_id: input.planId, p_decision: input.decision, p_reason: input.reason });
}

export function closeDayReview(env: ApiEnv, accessToken: string, input: {
  verdict: 'full_day' | 'mvd' | 'miss'; computedVerdict: 'full_day' | 'mvd' | 'miss';
  pillarReview: NonNullable<DayRecord['pillarReview']>; note?: string; carryForward?: string; insight: string;
}) {
  return loopRpc<DayRow>(env, accessToken, 'apm_close_day_review', {
    p_verdict: input.verdict, p_computed_verdict: input.computedVerdict, p_pillar_review: input.pillarReview,
    p_note: input.note ?? null, p_carry_forward: input.carryForward ?? null, p_insight: input.insight,
  });
}

export function getDailyLoopExportState(env: ApiEnv, accessToken: string) {
  return loopRpc<{ goalPlans: GoalPlanRow[]; planActionCompletions: CompletionRow[]; dayRecords: DayRow[] }>(env, accessToken, 'apm_daily_loop_data_rights_export', {});
}

// ---------------------------------------------------------------- 0027
export const logDiary = (env: ApiEnv, accessToken: string, input: { kind: 'diary' | 'breakthrough' | 'slip'; body: string }) =>
  loopRpc<{ entry: Record<string, unknown>; reply: 'Logged.' }>(env, accessToken, 'apm_log_diary', { p_kind: input.kind, p_body: input.body });
export const saveWeeklyReview = (env: ApiEnv, accessToken: string, input: { weekStart: string; summary: Record<string, unknown>; adjustment?: string }) =>
  loopRpc<Record<string, unknown>>(env, accessToken, 'apm_save_weekly_review', { p_week_start: input.weekStart, p_summary: input.summary, p_adjustment: input.adjustment ?? null });
export const draftOsChange = (env: ApiEnv, accessToken: string, input: { field: string; value: unknown; reason?: string }) =>
  loopRpc<{ id: string }>(env, accessToken, 'apm_draft_os_change', { p_field: input.field, p_value: input.value, p_reason: input.reason ?? null });
export interface PendingPillarRebuilds {
  /** Applied pillar changes now in effect whose plans are not rebuilt yet (0037). */
  changes: Array<{ id: string; pillar: string }>;
  /** Pillar rows in effect TODAY for pillars that also have a later change (0038); null = no row. */
  effective: Record<string, { name: string; active: boolean; critical: boolean; minimum_floor: string | null } | null>;
}
export async function pendingPillarRebuilds(env: ApiEnv, userId: string): Promise<PendingPillarRebuilds> {
  const raw = await loopRpc<Partial<PendingPillarRebuilds> | null>(env, serviceToken(env), 'apm_service_pending_pillar_rebuilds', { p_user_id: userId });
  return { changes: raw?.changes ?? [], effective: raw?.effective ?? {} };
}
/** Mandatory body-safety replan of a locked today (0038): never limited by the declared-replan cap. */
export function bodyReplanDay(env: ApiEnv, userId: string, input: { day: string; source: 'referral' | 'clearance'; agenda: DailyAgenda }) {
  return loopRpc<DayRow>(env, serviceToken(env), 'apm_service_day_body_replan', { p_user_id: userId, p_day: input.day, p_source: input.source, p_agenda: input.agenda });
}
export function markPillarRebuilt(env: ApiEnv, userId: string, id: string) {
  return loopRpc<boolean>(env, serviceToken(env), 'apm_service_mark_pillar_rebuilt', { p_user_id: userId, p_id: id });
}

export const applyOsChange = (env: ApiEnv, accessToken: string, id: string) => loopRpc<{ id: string; field: string; effective_from: string; proposed?: unknown }>(env, accessToken, 'apm_apply_os_change', { p_id: id });
export const discardOsChange = (env: ApiEnv, accessToken: string, id: string) => loopRpc<{ id: string }>(env, accessToken, 'apm_discard_os_change', { p_id: id });
export const setDayPhase = (env: ApiEnv, accessToken: string, phase: 'first_hour' | 'executing') => loopRpc<DayRow>(env, accessToken, 'apm_set_day_phase', { p_phase: phase });
export const returnResetDay = (env: ApiEnv, accessToken: string) => loopRpc<DayRow>(env, accessToken, 'apm_day_return_reset', {});
export const reprintDay = (env: ApiEnv, userId: string, input: { day: string; agenda: DailyAgenda }) => loopRpc<DayRow>(env, serviceToken(env), 'apm_service_day_reprint', { p_user_id: userId, p_day: input.day, p_agenda: input.agenda });
export const flagBodyReferral = (env: ApiEnv, accessToken: string, source: 'intake' | 'diary' | 'day_close' | 'goal' | 'os_change') => loopRpc<Record<string, unknown>>(env, accessToken, 'apm_flag_body_referral', { p_source: source });
export const recordClinicianClearance = (env: ApiEnv, accessToken: string) => loopRpc<Record<string, unknown>>(env, accessToken, 'apm_record_clinician_clearance', {});
