import {
  runOpenRouterInference,
  type InferenceTask,
  type ModelCapability,
  type ModelRoute,
} from '@apm/ai';
import type { DataClass, RetentionClass } from '@apm/privacy';
import type { ApiEnv } from './env';
import { requireOpenRouterKey } from './env';
import { supabaseRest } from './db';
import { listModelRoutes } from './platformRepository';

function mapRetention(value: string): RetentionClass {
  if (value === 'zero') return 'zero';
  if (value === 'limited') return 'limited';
  return 'unknown';
}

async function approvedRoutes(env: ApiEnv, accessToken: string): Promise<ModelRoute[]> {
  const rows = await listModelRoutes(env, accessToken);
  return rows.map((row) => ({
    routeId: row.route_id,
    modelId: row.model_id,
    providerId: row.provider_id,
    status: row.status as ModelRoute['status'],
    costClass: row.cost_class as ModelRoute['costClass'],
    capabilities: row.capabilities as ModelCapability[],
    dataClassesAllowed: row.data_classes_allowed as DataClass[],
    trainingAllowed: row.training_allowed,
    retention: mapRetention(row.retention),
    approvedForHighlySensitive: row.data_classes_allowed.includes('highly_sensitive'),
    qualityScore: 0,
    reliabilityScore: 0,
    latencyScore: 0,
    lastPolicyReviewedAt: row.last_policy_reviewed_at,
    lastEvalRunAt: row.last_eval_run_at ?? undefined,
  }));
}

export async function runUserInference<T>(input: {
  env: ApiEnv;
  accessToken: string;
  userId: string;
  task: InferenceTask;
}): Promise<T> {
  const routes = await approvedRoutes(input.env, input.accessToken);
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
