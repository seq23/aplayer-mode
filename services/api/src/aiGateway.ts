import {
  NoEligibleModelRouteError,
  runOpenRouterInference,
  selectModelRoute,
  type RouteRequest,
  type InferenceTask,
  type ModelCapability,
  type ModelRoute,
} from '@apm/ai';
import type { DataClass, RetentionClass } from '@apm/privacy';
import type { ApiEnv } from './env';
import { requireOpenRouterKey } from './env';
import { supabaseRest } from './db';
import { claimPaidCall, usageCount, utcDayStart } from './paidCalls';

/**
 * Owner-approved route for the two Suite mail jobs (her call, 21 Nov 2026): Outlook reply
 * drafts and subscription findings read private mail, so they may use ONLY this already
 * approved zero-retention, no-training route (about $0.05 per 1K calls), never a free one.
 * Two ceilings stop with a named stop before any call: a per-user daily cap for these jobs
 * and an app-wide daily ceiling from SUITE_MAIL_DAILY_CEILING. Nothing falls back to another
 * route.
 */
export const SUITE_MAIL_ROUTE = {
  routeId: 'or_mistral_small_3_2_24b_deepinfra',
  tasks: ['suite_reply_draft', 'suite_subscription_finding'],
  perUserPerDay: 20,
} as const;

export class SuiteMailStop extends Error {}

async function claimSuiteMailCall(env: ApiEnv, userId: string, taskType: string, now = new Date()) {
  if (!(SUITE_MAIL_ROUTE.tasks as readonly string[]).includes(taskType)) throw new SuiteMailStop('SUITE_MAIL_TASK_NOT_APPROVED');
  const ceiling = Number(env.SUITE_MAIL_DAILY_CEILING);
  if (!Number.isInteger(ceiling) || ceiling <= 0) throw new SuiteMailStop('SUITE_MAIL_CEILING_UNSET');
  const since = utcDayStart(now);
  let mine: number; let all: number;
  try {
    [mine, all] = await Promise.all([
      usageCount(env, since, userId, SUITE_MAIL_ROUTE.tasks),
      usageCount(env, since, undefined, SUITE_MAIL_ROUTE.tasks),
    ]);
  } catch {
    throw new SuiteMailStop('SUITE_MAIL_LIMIT_UNREADABLE');
  }
  if (all >= ceiling) throw new SuiteMailStop('SUITE_MAIL_DAILY_CEILING_REACHED');
  if (mine >= SUITE_MAIL_ROUTE.perUserPerDay) throw new SuiteMailStop('SUITE_MAIL_USER_DAILY_CAP');
}

function mapRetention(value: string): RetentionClass {
  if (value === 'zero') return 'zero';
  if (value === 'limited') return 'limited';
  return 'unknown';
}

interface ModelRouteRow {
  route_id: string;
  model_id: string;
  provider_id: string;
  status: ModelRoute['status'];
  cost_class: ModelRoute['costClass'];
  capabilities: string[];
  data_classes_allowed: string[];
  training_allowed: boolean;
  retention: string;
  approved_for_highly_sensitive: boolean;
  quality_score: number;
  reliability_score: number;
  latency_score: number;
  last_policy_reviewed_at: string;
  last_eval_run_at: string | null;
}

async function modelRoutesForRuntime(env: ApiEnv, accessToken: string): Promise<ModelRoute[]> {
  const rows = await supabaseRest<ModelRouteRow[]>(
    env,
    accessToken,
    '/rest/v1/model_routes?select=route_id,model_id,provider_id,status,cost_class,capabilities,data_classes_allowed,training_allowed,retention,approved_for_highly_sensitive,quality_score,reliability_score,latency_score,last_policy_reviewed_at,last_eval_run_at&order=cost_class.asc,route_id.asc',
  );
  return rows.map((row) => ({
    routeId: row.route_id,
    modelId: row.model_id,
    providerId: row.provider_id,
    status: row.status,
    costClass: row.cost_class,
    capabilities: row.capabilities as ModelCapability[],
    dataClassesAllowed: row.data_classes_allowed as DataClass[],
    trainingAllowed: row.training_allowed,
    retention: mapRetention(row.retention),
    approvedForHighlySensitive: row.approved_for_highly_sensitive,
    qualityScore: row.quality_score,
    reliabilityScore: row.reliability_score,
    latencyScore: row.latency_score,
    lastPolicyReviewedAt: row.last_policy_reviewed_at,
    lastEvalRunAt: row.last_eval_run_at ?? undefined,
  }));
}

/** True only when an `approved`, privacy-eligible route exists for the request — candidates never count. */
export async function hasEligibleRoute(env: ApiEnv, accessToken: string, request: RouteRequest): Promise<boolean> {
  return selectModelRoute(await modelRoutesForRuntime(env, accessToken), request) !== null;
}

/** USD → integer micro-USD for ai_usage_events.cost_microusd (the daily cap reads it). */
export function costMicroUsd(costUsd: number | undefined): number {
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? Math.round(costUsd * 1_000_000) : 0;
}

export async function runUserInference<T>(input: {
  env: ApiEnv;
  accessToken: string;
  userId: string;
  task: InferenceTask;
  /** The Suite mail jobs: only SUITE_MAIL_ROUTE, under its own two ceilings. */
  suiteMail?: boolean;
}): Promise<T> {
  if (input.suiteMail) await claimSuiteMailCall(input.env, input.userId, input.task.taskType);
  // Per-user and global daily ceilings before anything billed is called (src/paidCalls.ts).
  await claimPaidCall(input.env, input.userId);
  const all = await modelRoutesForRuntime(input.env, input.accessToken);
  const routes = input.suiteMail
    ? all.filter((route) => route.routeId === SUITE_MAIL_ROUTE.routeId && route.status === 'approved'
      && route.retention === 'zero' && !route.trainingAllowed)
    : all;
  if (input.suiteMail && !routes.length) throw new SuiteMailStop('SUITE_MAIL_ROUTE_NOT_APPROVED');
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runOpenRouterInference<T>>>;
  try {
    result = await runOpenRouterInference<T>({
      apiKey: requireOpenRouterKey(input.env),
      routes,
      task: input.task,
      appName: 'A Player Mode',
      appUrl: input.env.APP_PUBLIC_URL ?? 'https://aplayermode.com',
    });
  } catch (error) {
    await supabaseRest(input.env, input.accessToken, '/rest/v1/ai_usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: input.userId,
        route_id: null,
        task_type: input.task.taskType,
        data_class: error instanceof NoEligibleModelRouteError ? error.dataClass : input.task.dataClass,
        success: false,
        latency_ms: Date.now() - started,
        cost_microusd: 0,
        fallback_count: 0,
        error_code: error instanceof Error ? error.name : 'unknown_error',
      }]),
    }).catch(() => undefined);
    throw error;
  }
  // A failed usage write never throws away (or double-counts) a successful inference.
  try {
    await supabaseRest(input.env, input.accessToken, '/rest/v1/ai_usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: input.userId,
        route_id: result.route.routeId,
        task_type: input.task.taskType,
        data_class: result.dataClass,
        success: true,
        input_tokens: result.usage.inputTokens ?? null,
        output_tokens: result.usage.outputTokens ?? null,
        latency_ms: result.latencyMs,
        cost_microusd: costMicroUsd(result.usage.costUsd),
        fallback_count: 0,
      }]),
    });
  } catch (error) {
    console.error('APM ai usage write failed', { taskType: input.task.taskType, message: error instanceof Error ? error.message : String(error) });
  }
  return result.value;
}
