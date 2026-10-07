// Plain words for the daily screens (docs/36): every engine key a person could see on Today,
// Goals, Radar, the coach or the Diary is turned into words here, in ONE place, so no screen
// shows "plan_action", "at_risk", "slipping · high" or "Priority execution". Pure TS (no React
// Native) so apps/mobile/test can bundle it and pin it.

/** Today's copy. A burnt-out parent reads it at 6 a.m.: short, concrete, no system names. */
export const TODAY_COPY = {
  subtitle: 'Your plan for today is ready. Start with the first thing; APM keeps track of the rest.',
  subtitleRecovery: 'Today is a light day. One small thing counts. Nothing is owed from yesterday.',
  subtitleNoOs: 'Answer a few quick questions and APM writes your plan for today.',
  checkInLabel: 'Before you start',
  checkInLabelHard: 'Before you start',
  checkInQuestion: 'How is your energy right now, 1 to 10?',
  checkInBody: 'Tap a number. APM sizes today to fit it. At 2 or lower, today becomes a light day automatically.',
  checkInBodyHard: 'Tap a number. Your plan for today appears right after. At 2 or lower, today becomes a light day automatically.',
  checkInButton: 'Show my plan for today',
  checkInBusy: 'Setting up your day…',
  checkInReason: 'Tap a number above first.',
  priorityLabel: 'Do this first',
  afterCheckIn: 'Unlocks after you answer the energy question above.',
  drift: "Welcome back. Want APM to set up today's plan and restart the day?",
  noOsTitle: 'Answer a few quick questions so APM can plan around your real life.',
  noOsButton: 'Set up my plan',
  runOfShowEmpty: 'Connect your calendar and APM fits today around what is already booked.',
  runOfShowEmptyAction: 'Connect my calendar',
  approvalBody: 'APM got this ready but has not sent or changed anything. It only happens if you tap below.',
  approvalButton: 'Yes, do it',
  approvalBusy: 'Doing it…',
} as const;

/** What an agenda item is, in words (never the engine's `kind`). */
export const ITEM_KIND_WORDS: Readonly<Record<'plan_action' | 'plan_floor' | 'next_action' | 'track_floor' | 'carry_forward', string>> = {
  plan_action: 'Toward your goal',
  plan_floor: 'Daily minimum',
  next_action: 'Next step',
  track_floor: 'Daily minimum',
  carry_forward: 'From yesterday',
};

export const MODE_WORDS: Readonly<Record<string, string>> = {
  standard: 'Standard', high_pressure: 'High-Pressure', executive_review: 'Executive Review', sprint: 'Sprint', recovery: 'Recovery', deep_work: 'Deep Work',
};

export const VERDICT_WORDS: Readonly<Record<string, string>> = { full_day: 'Full day', mvd: 'Light day (it counts)', miss: 'Missed' };

/** Day-90 and gate recommendations: Promote / Maintain / Park, said as what happens. */
export const GATE_WORDS: Readonly<Record<string, string>> = {
  promote: 'make it your main goal',
  maintain: 'keep it going as it is',
  park: 'park it for now',
};

const RADAR_TYPE_WORDS: Readonly<Record<string, string>> = {
  urgent: 'Urgent', slipping: 'Slipping', waiting: 'Waiting on you', unanswered: 'Needs a reply', promised: 'You promised this',
  upcoming: 'Coming up', conflict: 'Clash', opportunity: 'Opportunity', recurring: 'Repeats',
};
const SEVERITY_WORDS: Readonly<Record<string, string>> = { low: '', medium: '', high: 'important', critical: 'very important' };

/** "Slipping · important", never "slipping · high". */
export function radarTag(type: string, severity: string): string {
  const what = RADAR_TYPE_WORDS[type] ?? 'Heads up';
  const how = SEVERITY_WORDS[severity];
  return how ? `${what} · ${how}` : what;
}

export const GOAL_HEALTH_WORDS: Readonly<Record<string, string>> = { on_track: 'On track', at_risk: 'Needs attention', stalled: 'Stuck', unknown: 'Just started' };
export const GOAL_STATUS_WORDS: Readonly<Record<string, string>> = { active: 'Active', paused: 'Paused', completed: 'Done', abandoned: 'Stopped' };

const DOMAIN_WORDS: Readonly<Record<string, string>> = { calendar: 'Calendar', email: 'Email', appointment: 'Appointment', subscription: 'Subscription' };
/** "Email · send reply", never "email · send_reply". */
export function actionTag(domain: string, actionType: string): string {
  const what = DOMAIN_WORDS[domain] ?? (domain ? domain[0]!.toUpperCase() + domain.slice(1) : 'Action');
  const how = actionType.replace(/_/g, ' ');
  return how ? `${what} · ${how}` : what;
}

export const DIARY_KIND_WORDS: Readonly<Record<string, string>> = { diary: 'Note', breakthrough: 'Breakthrough', slip: 'Slip' };

/** "7 Oct" from "2026-10-07" in the phone's own style; the ISO string never reaches a person. */
export function shortDate(iso: string | undefined | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Goal target dates are picked, never typed (docs/36 G2): APM offers horizons, the date is computed. */
export const TARGET_HORIZONS: ReadonlyArray<{ id: 'none' | '30' | '90' | '180' | '365'; label: string; days?: number }> = [
  { id: 'none', label: 'No date' },
  { id: '30', label: 'In a month', days: 30 },
  { id: '90', label: 'In 3 months', days: 90 },
  { id: '180', label: 'In 6 months', days: 180 },
  { id: '365', label: 'In a year', days: 365 },
];
export function targetDateFor(horizon: string, from: Date = new Date()): string | undefined {
  const days = TARGET_HORIZONS.find((h) => h.id === horizon)?.days;
  if (!days) return undefined;
  const date = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate() + days));
  return date.toISOString().slice(0, 10);
}

/** The intake's top line: how long is left, never "1 of 54" (docs/36 I1). About 7 s a tap. */
export function minutesLeftLabel(unanswered: number): string {
  if (unanswered <= 0) return 'Almost done';
  const minutes = Math.max(1, Math.round((unanswered * 7) / 60));
  return `About ${minutes} min left`;
}
