// A drafted Drafting Room change in words, never raw JSON (docs/35 U4).
import { AREA_LABELS, TRACK_DISPLAY_NAMES, type AreaKey, type OsChangeField } from '@apm/domain';

const FIRMNESS: Record<string, string> = { gentle: 'Gentle', direct: 'Direct', high_pressure: 'High-Pressure' };
const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

export function describeOsChange(field: OsChangeField, proposed: unknown): string {
  const v = proposed as Record<string, unknown> | string | number | boolean | unknown[] | null | undefined;
  switch (field) {
    case 'morning_sequence': { const steps = list(v); return steps.length ? `Morning: ${steps.map((step, i) => `${i + 1}. ${step}`).join('  ')}` : 'Morning: no steps'; }
    case 'hard_boundaries': return `Hard boundaries: ${list(v).join('; ') || 'none'}`;
    case 'non_negotiables': return `Non-negotiables: ${list(v).join('; ') || 'none'}`;
    case 'core_values': return `Values: ${list(v).join(', ') || 'none'}`;
    case 'north_star': return `North Star: ${String(v ?? '')}`;
    case 'coaching_firmness': return `Coaching style: ${FIRMNESS[String(v)] ?? String(v)}`;
    case 'day_start': return v === 'hard' ? 'Start the day with Hard Start' : 'Start the day with Guided Start';
    case 'coaching_reminder_days': return `Coaching reminder after ${Number(v)} days without a session`;
    case 'show_seven_day_snapshot': return v ? 'Show the 7-day snapshot on Today' : 'Hide the 7-day snapshot on Today';
    case 'review_day': return `Weekly debrief on ${String(v)}`;
    case 'recovery_day': return `Recovery day on ${String(v)}`;
    case 'tracks': { const keys = list(v); return keys.length ? `Tracks: ${keys.map((k) => TRACK_DISPLAY_NAMES[k as keyof typeof TRACK_DISPLAY_NAMES] ?? k).join(', ')}` : 'Tracks: none'; }
    case 'pillar': {
      const p = (v ?? {}) as { name?: string; critical?: boolean; minimumFloor?: string };
      const label = AREA_LABELS[p.name as AreaKey] ?? p.name ?? 'area';
      return `${label}: ${p.critical ? 'critical' : 'flexible'}${p.minimumFloor ? `, floor "${p.minimumFloor}"` : ''}`;
    }
    case 'track_settings': {
      const t = (v ?? {}) as { hardStop?: string; homeTouchpoint?: string; movementFloor?: string };
      const parts = [t.hardStop ? `hard stop ${t.hardStop}` : '', t.homeTouchpoint ? `home touchpoint "${t.homeTouchpoint}"` : '', t.movementFloor ? `movement floor "${t.movementFloor}"` : ''].filter(Boolean);
      return `Track settings: ${parts.join(', ') || 'no change'}`;
    }
    default: return 'A change to your OS';
  }
}
