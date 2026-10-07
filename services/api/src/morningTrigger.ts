import type { LifeGraphSnapshot } from '@apm/domain';
import type { ApiEnv } from './env';
import { SERVICE_ROLE_TOKEN, supabaseRest } from './db';
import { getLifeGraph } from './lifeGraphRepository';
import { getModeState } from './modeRepository';
import { reconcileModeState, type ModeState } from './coach/modes';
import { todayLoopState, reconcilePillarRebuilds } from './dailyLoop';
import { inQuietHours, sendExpoPush } from './push';

/**
 * BHPC Part V "auto-deliver the Morning Trigger": a Cloudflare Cron Trigger runs this
 * every 15 minutes. For each user whose local wake time has arrived it prints the day's
 * agenda (never locks it: the check-in still runs the Mood Gate) and sends ONE push per
 * user per local day. The database claim (`morning:<day>`, unique per user) is the
 * idempotency key, so overlapping or repeated cron runs never double-send.
 *
 * Holds (no claim, so a later tick sends it): an active Deep Work block, or a protected
 * family block happening right now. Notification settings are respected: disabled
 * notifications / Morning Trigger / no device are filtered in SQL; quiet hours suppress.
 */

export interface MorningCandidate { user_id: string; timezone: string; wake_time: string; local_day: string }
export interface MorningRunResult {
  skipped?: 'no_service_credential';
  considered: number;
  printed: number;
  sent: number;
  held: number;
  suppressed: number;
  failed: number;
  alreadyClaimed: number;
}

interface PreferenceRow { enabled: boolean; quiet_hours: Record<string, unknown>; lock_screen_detail: 'minimal' | 'normal'; morning_push_enabled: boolean }

const serviceRpc = <T>(env: ApiEnv, fn: string, args: Record<string, unknown>) =>
  supabaseRest<T>(env, SERVICE_ROLE_TOKEN, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

export type PushHold = { reason: 'deep_work' | 'protected_family_block'; allowCritical: boolean; allowFamily: boolean; until?: string };

/**
 * Work pushes are held during a Deep Work block (one uninterrupted task) and during a
 * protected family block (Home Front: "during protected blocks, notifications for work
 * items are held").
 */
export function workPushHold(graph: Pick<LifeGraphSnapshot, 'lifeAdminItems' | 'tracks'>, mode: ModeState, now: Date): PushHold | undefined {
  if (mode.mode === 'deep_work' && mode.endsAt && Date.parse(mode.endsAt) > now.getTime()) {
    return { reason: 'deep_work', allowCritical: true, allowFamily: false, until: mode.endsAt };
  }
  const familyBlock = (graph.lifeAdminItems ?? []).find((item) =>
    item.kind === 'family_obligation'
    && !['completed', 'cancelled', 'paused'].includes(item.status)
    && item.startsAt && item.endsAt
    && Date.parse(item.startsAt) <= now.getTime() && Date.parse(item.endsAt) > now.getTime());
  if (familyBlock) return { reason: 'protected_family_block', allowCritical: true, allowFamily: true, until: familyBlock.endsAt };
  return undefined;
}

function morningCopy(detail: 'minimal' | 'normal', foreground?: string) {
  if (detail === 'normal' && foreground) return { title: 'Your agenda is ready', body: `Today's foreground: ${foreground}`.slice(0, 200) };
  return { title: 'Your agenda is ready', body: 'Open APM to start the day.' };
}

export async function runMorningTrigger(env: ApiEnv, now: Date = new Date(), limit = 200): Promise<MorningRunResult> {
  const result: MorningRunResult = { considered: 0, printed: 0, sent: 0, held: 0, suppressed: 0, failed: 0, alreadyClaimed: 0 };
  if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) {
    // Named stop: the scheduled run is visible in Workers logs instead of exiting silently.
    console.warn('APM morning trigger: SUPABASE_SECRET_KEY is not configured; no agendas printed');
    return { ...result, skipped: 'no_service_credential' };
  }
  const candidates = await serviceRpc<MorningCandidate[]>(env, 'apm_service_morning_candidates', { p_now: now.toISOString(), p_limit: limit });
  for (const candidate of candidates) {
    result.considered += 1;
    try {
      const { outcome, printed } = await deliverMorningTrigger(env, candidate, now);
      result[outcome] += 1;
      if (printed) result.printed += 1;
    } catch (error) {
      result.failed += 1;
      console.error('APM morning trigger failed for one user', { name: (error as Error)?.name, message: (error as Error)?.message });
    }
  }
  return result;
}

type Outcome = 'sent' | 'held' | 'suppressed' | 'failed' | 'alreadyClaimed';

async function deliverMorningTrigger(env: ApiEnv, candidate: MorningCandidate, now: Date): Promise<{ outcome: Outcome; printed: boolean }> {
  const done = (outcome: Outcome, printed = false) => ({ outcome, printed });
  const userId = candidate.user_id;
  // A pillar change that took effect today reaches its plans before the agenda prints (0037).
  await reconcilePillarRebuilds(env, SERVICE_ROLE_TOKEN, userId);
  const graph = await getLifeGraph(env, SERVICE_ROLE_TOKEN, userId);
  const mode = reconcileModeState(await getModeState(env, SERVICE_ROLE_TOKEN, userId), now, graph.identity.timezone).state;
  if (workPushHold(graph, mode, now)) return done('held');

  const today = todayLoopState(graph, { now, recoveryMode: mode.mode === 'recovery' });
  if (today.date !== candidate.local_day) return done('held');
  const started = today.checkedIn || today.closed;
  const printed = started ? false : await serviceRpc<boolean>(env, 'apm_service_print_agenda', { p_user_id: userId, p_day: today.date, p_agenda: today.agenda });

  const [preferences, subscriptions] = await Promise.all([
    supabaseRest<PreferenceRow[]>(env, SERVICE_ROLE_TOKEN, `/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(userId)}&select=enabled,quiet_hours,lock_screen_detail,morning_push_enabled&limit=1`),
    supabaseRest<Array<{ expo_push_token: string }>>(env, SERVICE_ROLE_TOKEN, `/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=expo_push_token`),
  ]);
  const pref = preferences[0] ?? { enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal' as const, morning_push_enabled: true };
  const copy = morningCopy(pref.lock_screen_detail, today.agenda.foregroundPriority?.label);
  const claimed = await serviceRpc<string | null>(env, 'apm_service_claim_notification', {
    p_user_id: userId, p_dedupe_key: `morning:${today.date}`, p_title: copy.title, p_body: copy.body, p_deep_link: '/today',
  });
  if (!claimed) return done('alreadyClaimed', printed);

  const finish = (status: 'sent' | 'failed' | 'suppressed', reason: string | null) =>
    serviceRpc<void>(env, 'apm_service_finish_notification', { p_id: claimed, p_status: status, p_reason: reason });
  let suppression: string | undefined;
  if (!pref.enabled || !pref.morning_push_enabled) suppression = 'notifications_disabled';
  else if (started) suppression = 'day_already_started';
  else if (inQuietHours(pref.quiet_hours ?? {}, now, graph.identity.timezone)) suppression = 'quiet_hours';
  else if (subscriptions.length === 0) suppression = 'no_push_subscription';
  if (suppression) { await finish('suppressed', suppression); return done('suppressed', printed); }

  const response = await sendExpoPush(env, subscriptions.map((subscription) => ({
    to: subscription.expo_push_token, title: copy.title, body: copy.body, sound: 'default', data: { type: 'morning_trigger', deepLink: '/today', day: today.date },
  })));
  // Expo's per-message tickets decide (HTTP 200 can carry only errors); a failed push stays retryable.
  if (!response.delivered) { await finish('failed', response.error ?? 'expo_failed'); return done('failed', printed); }
  await finish('sent', null);
  return done('sent', printed);
}
