import {
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

export async function runUserInference<T>(input: {
  env: ApiEnv;
  accessToken: string;
  userId: string;
  task: InferenceTask;
}): Promise<T> {
  const routes = await modelRoutesForRuntime(input.env, input.accessToken);
  const started = Date.now();
  try {
    const result = await runOpenRouterInference<T>({
      apiKey: requireOpenRouterKey(input.env),
      routes,
      task: input.task,
      appName: 'A Player Mode',
      appUrl: input.env.APP_PUBLIC_URL ?? 'https://aplayermode.com',
    });
    await supabaseRest(input.env, input.accessToken, '/rest/v1/ai_usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: input.userId,
        route_id: result.route.routeId,
        task_type: input.task.taskType,
        data_class: input.task.dataClass,
        success: true,
        input_tokens: result.usage.inputTokens ?? null,
        output_tokens: result.usage.outputTokens ?? null,
        latency_ms: result.latencyMs,
        cost_microusd: 0,
        fallback_count: 0,
      }]),
    });
    return result.value;
  } catch (error) {
    await supabaseRest(input.env, input.accessToken, '/rest/v1/ai_usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: input.userId,
        route_id: null,
        task_type: input.task.taskType,
        data_class: input.task.dataClass,
        success: false,
        latency_ms: Date.now() - started,
        cost_microusd: 0,
        fallback_count: 0,
        error_code: error instanceof Error ? error.name : 'unknown_error',
      }]),
    }).catch(() => undefined);
    throw error;
  }
}
