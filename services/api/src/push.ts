import type { RadarItem } from '@apm/domain';
import type { ApiEnv } from './env';
import { serviceRpc, supabaseRest } from './db';

const severityValue: Record<RadarItem['severity'], number> = { low: 0, medium: 1, high: 2, critical: 3 };

interface PreferenceRow { enabled: boolean; quiet_hours: Record<string, unknown>; lock_screen_detail: 'minimal' | 'normal'; minimum_severity: RadarItem['severity'] }
interface SubscriptionRow { expo_push_token: string }

function notificationCopy(item: RadarItem, detail: 'minimal' | 'normal') {
  if (detail === 'minimal') {
    return { title: 'APM noticed something', body: item.severity === 'critical' ? 'Something important needs your attention.' : 'There is something worth checking.' };
  }
  return { title: 'APM noticed something', body: item.headline.slice(0, 180) };
}

/** Minutes since local midnight in the user's timezone (UTC if unknown). */
export function localMinutes(now: Date, timezone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  } catch { /* unknown timezone: fall through to UTC */ }
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

/** Quiet hours are the user's LOCAL clock (they were compared against UTC before 0022). */
export function inQuietHours(quiet: Record<string, unknown>, now: Date, timezone?: string): boolean {
  const start = typeof quiet.start === 'string' ? quiet.start : undefined;
  const end = typeof quiet.end === 'string' ? quiet.end : undefined;
  if (!start || !end) return false;
  const minutes = localMinutes(now, timezone);
  const parse = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : -1;
  };
  const a = parse(start); const b = parse(end);
  if (a < 0 || b < 0) return false;
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

export interface ExpoPushOutcome {
  /** True only when the request succeeded AND Expo accepted at least one message. */
  delivered: boolean;
  /** The failure recorded on the notification when not delivered. */
  error?: string;
  /** Tokens Expo reported as DeviceNotRegistered (already deactivated when possible). */
  deadTokens: string[];
}

/**
 * Sends, then reads Expo's per-message tickets: Expo answers HTTP 200 even when every
 * message failed (`data[i].status === 'error'`), so HTTP status alone is never "sent".
 * Dead tokens are deactivated through the service role (0045) so they stop being used.
 */
export async function sendExpoPush(env: ApiEnv, messages: Array<Record<string, unknown>>): Promise<ExpoPushOutcome> {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages),
  });
  if (!response.ok) return { delivered: false, error: `expo_http_${response.status}`, deadTokens: [] };
  const body = await response.json().catch(() => null) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
  const tickets = Array.isArray(body?.data) ? body!.data! : [];
  const deadTokens = tickets.flatMap((ticket, index) => ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' && typeof messages[index]?.to === 'string' ? [messages[index]!.to as string] : []);
  if (deadTokens.length && env.SUPABASE_SECRET_KEY) {
    await serviceRpc(env, 'apm_service_deactivate_push_tokens', { p_tokens: deadTokens })
      .catch((error: unknown) => console.error('APM push: could not deactivate dead tokens', { message: error instanceof Error ? error.message : String(error) }));
  }
  if (tickets.some((ticket) => ticket?.status === 'ok')) return { delivered: true, deadTokens };
  const firstError = tickets.find((ticket) => ticket?.status === 'error')?.details?.error;
  return { delivered: false, error: `expo_${firstError ?? 'no_ticket'}`.slice(0, 120), deadTokens };
}

export async function notifyRadarItems(input: {
  env: ApiEnv; accessToken: string; userId: string; radarItems: RadarItem[]; now?: Date;
  timezone?: string;
  /** Deep Work block or a protected family block: work pushes are HELD (not recorded), so they go out after it. */
  hold?: { reason: string; allowCritical: boolean; allowFamily: boolean };
}): Promise<{ queued: number; sent: number; suppressed: number; held: number }> {
  const now = input.now ?? new Date();
  let held = 0;
  const [preferences, subscriptions] = await Promise.all([
    supabaseRest<PreferenceRow[]>(input.env, input.accessToken, `/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(input.userId)}&select=*&limit=1`),
    supabaseRest<SubscriptionRow[]>(input.env, input.accessToken, `/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(input.userId)}&active=eq.true&select=expo_push_token`),
  ]);
  const pref = preferences[0] ?? { enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal' as const, minimum_severity: 'medium' as const };
  let queued = 0; let sent = 0; let suppressed = 0;

  for (const item of input.radarItems) {
    if (item.status !== 'open') continue;
    if (input.hold) {
      const family = item.reasonCodes.some((code) => /family|relationship|home\./.test(code));
      const exempt = (input.hold.allowCritical && item.severity === 'critical') || (input.hold.allowFamily && family);
      if (!exempt) { held += 1; continue; }
    }
    const dedupeKey = `radar:${item.id}`;
    let suppressionReason: string | undefined;
    if (!pref.enabled) suppressionReason = 'notifications_disabled';
    else if (severityValue[item.severity] < severityValue[pref.minimum_severity]) suppressionReason = 'below_severity_threshold';
    else if (inQuietHours(pref.quiet_hours ?? {}, now, input.timezone) && item.severity !== 'critical') suppressionReason = 'quiet_hours';
    else if (item.confidence < 0.75) suppressionReason = 'low_confidence';
    else if (subscriptions.length === 0) suppressionReason = 'no_push_subscription';

    // Claim first (insert-or-nothing on the dedupe key): of two concurrent evaluations
    // only the one whose insert landed sends, so a push never goes out twice.
    const copy = notificationCopy(item, pref.lock_screen_detail);
    const claimed = await supabaseRest<Array<{ id: string }>>(input.env, input.accessToken, '/rest/v1/notifications?on_conflict=user_id,dedupe_key&select=id', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ user_id: input.userId, radar_item_id: null, title: copy.title, body: copy.body, deep_link: `/radar/${encodeURIComponent(item.id)}`, dedupe_key: dedupeKey,
        status: suppressionReason ? 'suppressed' : 'queued', suppression_reason: suppressionReason ?? null }]),
    });
    const claimId = claimed?.[0]?.id;
    if (!claimId) continue;
    if (suppressionReason) { suppressed += 1; continue; }

    queued += 1;
    const messages = subscriptions.map((subscription) => ({ to: subscription.expo_push_token, title: copy.title, body: copy.body, data: { type: 'radar', radarId: item.id, deepLink: `/radar/${item.id}` }, sound: 'default' }));
    const outcome = await sendExpoPush(input.env, messages);
    if (outcome.delivered) sent += 1;
    await supabaseRest(input.env, input.accessToken, `/rest/v1/notifications?id=eq.${encodeURIComponent(claimId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: outcome.delivered ? 'sent' : 'failed', sent_at: outcome.delivered ? new Date().toISOString() : null, suppression_reason: outcome.delivered ? null : outcome.error ?? null }),
    });
  }
  return { queued, sent, suppressed, held };
}
