/**
 * Client analytics events carry no raw private content (AGENTS.md): every event has an
 * explicit allow-list of property keys, each a short id, an enum, a count or a boolean.
 * Anything else — unknown keys, free text, long strings — is dropped before storage.
 */
type Rule = 'id' | 'bool' | 'count' | readonly string[];

const MODES = ['standard', 'recovery', 'high_pressure', 'executive_review', 'sprint', 'deep_work'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const PLANS = ['beta', 'chief_of_staff', 'life_os', 'autopilot', 'household'] as const;

export const CLIENT_ANALYTICS_EVENTS = {
  daily_plan_viewed: { mode: MODES },
  radar_item_viewed: { radarItemId: 'id', severity: SEVERITIES },
  radar_item_acted: { radarItemId: 'id', severity: SEVERITIES },
  radar_item_corrected: { radarItemId: 'id', severity: SEVERITIES },
  radar_item_dismissed: { radarItemId: 'id', severity: SEVERITIES },
  privacy_center_viewed: {},
  provider_transparency_viewed: {},
  notification_opened: { notificationType: ['radar', 'morning_trigger'] },
  integration_disconnected: { provider: ['google', 'microsoft', 'device', 'apple_caldav'], kind: ['calendar', 'email'] },
  household_interest_changed: { interested: 'bool' },
  product_plan_viewed: { plan: PLANS },
  life_os_relationship_saved: {},
  life_os_item_created: { kind: 'id' },
  life_os_item_completed: { kind: 'id', recurring: 'bool' },
} as const satisfies Record<string, Record<string, Rule>>;

export type ClientAnalyticsEvent = keyof typeof CLIENT_ANALYTICS_EVENTS;
export const CLIENT_ANALYTICS_EVENT_NAMES = Object.keys(CLIENT_ANALYTICS_EVENTS) as [ClientAnalyticsEvent, ...ClientAnalyticsEvent[]];

const SHORT_ID = /^[A-Za-z0-9:_.-]{1,64}$/;

export function sanitizeAnalyticsProperties(event: ClientAnalyticsEvent, properties: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const rules = CLIENT_ANALYTICS_EVENTS[event] as Record<string, Rule>;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = properties[key];
    if (rule === 'bool') { if (typeof value === 'boolean') out[key] = value; }
    else if (rule === 'count') { if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000) out[key] = value; }
    else if (rule === 'id') { if (typeof value === 'string' && SHORT_ID.test(value)) out[key] = value; }
    else if (typeof value === 'string' && rule.includes(value)) out[key] = value;
  }
  return out;
}
