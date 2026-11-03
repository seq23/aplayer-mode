import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';

/**
 * The one guard in front of every billed model call (OpenRouter on the product's key).
 *
 * Three limits, all enforced here and nowhere else:
 *   1. burst, per user: PAID_CALL_LIMITS.perUserPerMinute through the PAID_CALL_LIMITER Workers
 *      rate-limit binding (a per-isolate limiter stands in without it). Paid ROUTES check it
 *      first and answer 429 (`paidRouteAllowed`).
 *   2. daily, per user: PAID_CALL_LIMITS.perUserPerDay attempts, counted from ai_usage_events
 *      (every attempt writes one row, success or not) since 00:00 UTC.
 *   3. daily, global: PAID_CALL_LIMITS.globalPerDay attempts across ALL users, the bill ceiling
 *      that holds even against many throwaway (anonymous) accounts.
 *
 * 2 and 3 run inside runUserInference (aiGateway.ts) before the provider is called, so no
 * caller can skip them. They fail closed: a count that cannot be read refuses the call. Every
 * caller already degrades to its deterministic path when inference throws (coaching keeps the
 * scripted BHPC turn, intake synthesis the deterministic proposal); email sync answers 429.
 */
export const PAID_CALL_LIMITS = {
  perUserPerMinute: 20,
  perUserPerDay: 300,
  globalPerDay: 20_000,
} as const;

export type PaidCallRefusal = 'rate_limited' | 'user_daily_limit' | 'global_daily_limit' | 'limit_unreadable';

export class PaidCallRefused extends Error {
  constructor(public readonly reason: PaidCallRefusal) {
    super(`paid_call_refused:${reason}`);
    this.name = 'PaidCallRefused';
  }
}

const localHits = new Map<string, number[]>();
const WINDOW_MS = 60_000;

/** A Workers rate-limit binding, or a per-isolate sliding window when it is absent/unavailable. */
export async function limiterAllows(
  binding: ApiEnv['PAID_CALL_LIMITER'],
  key: string,
  perMinute: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (binding) {
    try { return (await binding.limit({ key })).success; } catch { /* fall back below */ }
  }
  const recent = (localHits.get(key) ?? []).filter((at) => at > nowMs - WINDOW_MS);
  if (recent.length >= perMinute) { localHits.set(key, recent); return false; }
  recent.push(nowMs); localHits.set(key, recent);
  if (localHits.size > 5000) localHits.clear();
  return true;
}

/** Route-level burst check for every endpoint that can reach a billed model. */
export function paidRouteAllowed(env: ApiEnv, userId: string): Promise<boolean> {
  return limiterAllows(env.PAID_CALL_LIMITER, `paid-call:${userId}`, PAID_CALL_LIMITS.perUserPerMinute);
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Exact row count of ai_usage_events since `since` (optionally one user's), with the service key. */
async function usageCount(env: ApiEnv, since: string, userId?: string): Promise<number> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('no service credential');
  const headers = new Headers({ apikey: secret, prefer: 'count=exact', range: '0-0', 'range-unit': 'items' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  const filter = `created_at=gte.${encodeURIComponent(since)}${userId ? `&user_id=eq.${encodeURIComponent(userId)}` : ''}`;
  const response = await fetch(`${url}/rest/v1/ai_usage_events?select=id&${filter}`, { method: 'HEAD', headers });
  if (!response.ok && response.status !== 206) throw new Error(`count failed ${response.status}`);
  const total = Number((response.headers.get('content-range') ?? '').split('/')[1]);
  if (!Number.isFinite(total) || total < 0) throw new Error('count unreadable');
  return total;
}

/** Throws PaidCallRefused unless this user, and everyone together, are under today's ceilings. */
export async function claimPaidCall(env: ApiEnv, userId: string, now: Date = new Date()): Promise<void> {
  const since = utcDayStart(now);
  let mine: number; let all: number;
  try {
    [mine, all] = await Promise.all([usageCount(env, since, userId), usageCount(env, since)]);
  } catch {
    throw new PaidCallRefused('limit_unreadable');
  }
  if (all >= PAID_CALL_LIMITS.globalPerDay) throw new PaidCallRefused('global_daily_limit');
  if (mine >= PAID_CALL_LIMITS.perUserPerDay) throw new PaidCallRefused('user_daily_limit');
}
