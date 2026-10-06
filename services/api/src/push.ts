import type { RadarItem } from '@apm/domain';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';

const severityValue: Record<RadarItem['severity'], number> = { low: 0, medium: 1, high: 2, critical: 3 };

interface PreferenceRow { enabled: boolean; quiet_hours: Record<string, unknown>; lock_screen_detail: 'minimal' | 'normal'; minimum_severity: RadarItem['severity'] }
interface SubscriptionRow { expo_push_token: string }

function notificationCopy(item: RadarItem, detail: 'minimal' | 'normal') {
  if (detail === 'minimal') {
    return { title: 'APM noticed something', body: item.severity === 'critical' ? 'Something important needs your attention.' : 'There is something worth checking.' };
  }
  return { title: 'APM noticed something', body: item.headline.slice(0, 180) };
}

function inQuietHours(quiet: Record<string, unknown>, now: Date): boolean {
  const start = typeof quiet.start === 'string' ? quiet.start : undefined;
  const end = typeof quiet.end === 'string' ? quiet.end : undefined;
  if (!start || !end) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const parse = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : -1;
  };
  const a = parse(start); const b = parse(end);
  if (a < 0 || b < 0) return false;
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

export async function notifyRadarItems(input: {
  env: ApiEnv; accessToken: string; userId: string; radarItems: RadarItem[]; now?: Date;
}): Promise<{ queued: number; sent: number; suppressed: number }> {
  const now = input.now ?? new Date();
  const [preferences, subscriptions] = await Promise.all([
    supabaseRest<PreferenceRow[]>(input.env, input.accessToken, `/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(input.userId)}&select=*&limit=1`),
    supabaseRest<SubscriptionRow[]>(input.env, input.accessToken, `/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(input.userId)}&active=eq.true&select=expo_push_token`),
  ]);
  const pref = preferences[0] ?? { enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal' as const, minimum_severity: 'medium' as const };
  let queued = 0; let sent = 0; let suppressed = 0;

  for (const item of input.radarItems) {
    if (item.status !== 'open') continue;
    const dedupeKey = `radar:${item.id}`;
    const existing = await supabaseRest<Array<{ id: string; status: string }>>(input.env, input.accessToken, `/rest/v1/notifications?user_id=eq.${encodeURIComponent(input.userId)}&dedupe_key=eq.${encodeURIComponent(dedupeKey)}&select=id,status&limit=1`);
    if (existing.length > 0) continue;

    let suppressionReason: string | undefined;
    if (!pref.enabled) suppressionReason = 'notifications_disabled';
    else if (severityValue[item.severity] < severityValue[pref.minimum_severity]) suppressionReason = 'below_severity_threshold';
    else if (inQuietHours(pref.quiet_hours ?? {}, now) && item.severity !== 'critical') suppressionReason = 'quiet_hours';
    else if (item.confidence < 0.75) suppressionReason = 'low_confidence';
    else if (subscriptions.length === 0) suppressionReason = 'no_push_subscription';

    const copy = notificationCopy(item, pref.lock_screen_detail);
    if (suppressionReason) {
      suppressed += 1;
      await supabaseRest(input.env, input.accessToken, '/rest/v1/notifications', {
        method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: input.userId, radar_item_id: item.id.startsWith('radar:') ? null : item.id, title: copy.title, body: copy.body, deep_link: `/radar/${encodeURIComponent(item.id)}`, dedupe_key: dedupeKey, status: 'suppressed', suppression_reason: suppressionReason }]),
      });
      continue;
    }

    queued += 1;
    const messages = subscriptions.map((subscription) => ({ to: subscription.expo_push_token, title: copy.title, body: copy.body, data: { type: 'radar', radarId: item.id, deepLink: `/radar/${item.id}` }, sound: 'default' }));
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${input.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(messages),
    });
    const status = response.ok ? 'sent' : 'failed';
    if (response.ok) sent += 1;
    await supabaseRest(input.env, input.accessToken, '/rest/v1/notifications', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: input.userId, radar_item_id: null, title: copy.title, body: copy.body, deep_link: `/radar/${encodeURIComponent(item.id)}`, dedupe_key: dedupeKey, status, sent_at: response.ok ? new Date().toISOString() : null, suppression_reason: response.ok ? null : `expo_http_${response.status}` }]),
    });
  }
  return { queued, sent, suppressed };
}
