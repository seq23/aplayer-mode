import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { PAID_AI_DAILY_LIMIT } from '@apm/policy';

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
 *   4. monthly, per user (not shown to people, a backstop): PAID_CALL_LIMITS.perUserMonthlyMicroUsd
 *      of billed model cost (ai_usage_events.cost_microusd, OpenRouter's own charge) since the 1st
 *      (UTC), so every subscriber nets at least $1 after AI cost (her ruling 21 Nov 2026):
 *        lowest price anyone pays   $9.99/month (Founding Member / introductory Executive Roundtable)
 *        after Apple's 30%          $6.99  (worst store cut until the Small Business Program)
 *        minus the $1 net floor     $5.99  most AI may cost per subscriber per month
 *        backstop                   $5.00  ($1.99 net at worst, leaving room for list-price drift)
 *      The disclosed limit is the daily one (2), in the words of DAILY_AI_LIMIT_LINE (@apm/policy).
 *
 * 2, 3 and 4 run inside runUserInference (aiGateway.ts) before the provider is called, so no
 * caller can skip them. They fail closed: a count that cannot be read refuses the call. Every
 * caller already degrades to its deterministic path when inference throws (coaching keeps the
 * scripted BHPC turn, intake synthesis the deterministic proposal); email sync answers 429.
 */
export const PAID_CALL_LIMITS = {
  perUserPerMinute: 20,
  perUserPerDay: PAID_AI_DAILY_LIMIT,
  globalPerDay: 20_000,
  perUserMonthlyMicroUsd: 5_000_000,
} as const;


export type PaidCallRefusal = 'rate_limited' | 'user_daily_limit' | 'global_daily_limit' | 'user_monthly_backstop' | 'limit_unreadable';

export class PaidCallRefused extends Error {
  constructor(public readonly reason: PaidCallRefusal) {
    super(`paid_call_refused:${reason}`);
    this.name = 'PaidCallRefused';
  }
}

/** What a refused billed call tells the person (HTTP 429 body): true about when it works again. The daily limit is disclosed; the backstop is not named. */
export function paidRefusal(reason: PaidCallRefusal) {
  if (reason === 'user_daily_limit') return { error: 'daily_ai_limit', message: "You've used today's AI requests. Inbox scanning starts again tomorrow.", reason };
  if (reason === 'user_monthly_backstop' || reason === 'global_daily_limit') return { error: 'ai_paused', message: 'Inbox scanning is paused for now and starts again on its own. Your plan and coaching keep working.', reason };
  return { error: 'rate_limited', message: 'Too many requests. Wait a minute and try again.', reason };
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

export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** One user's billed model cost (micro-USD) since `since`, summed in the database (0107). */
export async function costSince(env: ApiEnv, userId: string, since: string): Promise<number> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('no service credential');
  const headers = new Headers({ apikey: secret, 'content-type': 'application/json' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  const response = await fetch(`${url}/rest/v1/rpc/apm_ai_cost_microusd_since`, {
    method: 'POST', headers, body: JSON.stringify({ p_user_id: userId, p_since: since }),
  });
  if (!response.ok) throw new Error(`cost sum failed ${response.status}`);
  const total = Number(await response.json());
  if (!Number.isFinite(total) || total < 0) throw new Error('cost unreadable');
  return total;
}

/** Exact row count of ai_usage_events since `since` (optionally one user's), with the service key. */
export async function usageCount(env: ApiEnv, since: string, userId?: string, taskTypes?: readonly string[]): Promise<number> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('no service credential');
  const headers = new Headers({ apikey: secret, prefer: 'count=exact', range: '0-0', 'range-unit': 'items' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  const filter = `created_at=gte.${encodeURIComponent(since)}${userId ? `&user_id=eq.${encodeURIComponent(userId)}` : ''}`
    + (taskTypes?.length ? `&task_type=in.(${taskTypes.map(encodeURIComponent).join(',')})` : '');
  const response = await fetch(`${url}/rest/v1/ai_usage_events?select=id&${filter}`, { method: 'HEAD', headers });
  if (!response.ok && response.status !== 206) throw new Error(`count failed ${response.status}`);
  const total = Number((response.headers.get('content-range') ?? '').split('/')[1]);
  if (!Number.isFinite(total) || total < 0) throw new Error('count unreadable');
  return total;
}

/** Throws PaidCallRefused unless this user, and everyone together, are under today's ceilings and this user under the month's backstop. */
export async function claimPaidCall(env: ApiEnv, userId: string, now: Date = new Date()): Promise<void> {
  const since = utcDayStart(now);
  let mine: number; let all: number; let month: number;
  try {
    [mine, all, month] = await Promise.all([usageCount(env, since, userId), usageCount(env, since), costSince(env, userId, utcMonthStart(now))]);
  } catch {
    throw new PaidCallRefused('limit_unreadable');
  }
  if (all >= PAID_CALL_LIMITS.globalPerDay) throw new PaidCallRefused('global_daily_limit');
  if (mine >= PAID_CALL_LIMITS.perUserPerDay) throw new PaidCallRefused('user_daily_limit');
  if (month >= PAID_CALL_LIMITS.perUserMonthlyMicroUsd) throw new PaidCallRefused('user_monthly_backstop');
}
