import type { DailyPlan, DailyPlanBlock, LifeGraphSnapshot, OperatingModeKey } from '@apm/domain';
import { isExecutableActionTitle } from '@apm/planning';

/**
 * Modes as explicit, user-controlled state (BHPC Appendix B + Part VIII;
 * APP-INTENT invariant 9 "Modes are explicit state changes, not hidden
 * personality shifts"). Every rule here is deterministic: entering, exiting,
 * auto-exit and the effect on Today need no LLM.
 */
export interface ModeDefinition {
  key: OperatingModeKey;
  name: string;
  purpose: string;
  rules: string[];
  exitProtocol: string;
  todayEffect: string;
}

export const MODE_LIBRARY: Record<OperatingModeKey, ModeDefinition> = {
  standard: {
    key: 'standard',
    name: 'Standard',
    purpose: 'Your usual day: your plan, one step at a time.',
    rules: ['One question at a time.', 'Coaching ends with you back on your plan.'],
    exitProtocol: 'Standard is the default; choose another mode to change how APM holds the day.',
    todayEffect: 'Full agenda.',
  },
  high_pressure: {
    key: 'high_pressure',
    name: 'High-Pressure Coaching',
    purpose: 'Direct executive-mentor coaching when stakes are high or execution has drifted.',
    rules: [
      'Coaching is direct and uncompromising; no comfort language.',
      'Weak assumptions are challenged immediately; the stated problem is treated as a symptom.',
      'Only the highest-leverage moves.',
      'Insights arrive as a numbered list — no prose paragraphs.',
      'At most ONE question per response.',
      'Every session ends with ONE stabilizing directive.',
      'Never shame, coerce or manipulate.',
    ],
    exitProtocol: 'Stays on until you exit it or ask for the standard coaching tone.',
    todayEffect: 'No change to Today; changes how coaching pushes.',
  },
  executive_review: {
    key: 'executive_review',
    name: 'Executive Review',
    purpose: 'Organize what you already know — no new ideas, no re-diagnosis.',
    rules: [
      'Opens with: “Here’s what you already know that still makes you better:”',
      'Numbered list of 3–7 items drawn only from what APM already knows about you.',
      'Examines current priorities, opportunity quality, execution progress and strategic positioning.',
      'Introduces no new insights and asks no questions.',
      'Closes with: “None of this is new — you’re just being reminded.” and one grounding directive.',
    ],
    exitProtocol: 'Ends when the review session closes, or when you exit.',
    todayEffect: 'No change to Today.',
  },
  sprint: {
    key: 'sprint',
    name: 'Sprint',
    purpose: 'A bounded maximum-output window for a defined high-stakes deadline.',
    rules: [
      'Duration is declared up front: 1–14 days.',
      'One foreground project only — everything else moves to maintenance.',
      'Agenda is compressed to sprint-critical tasks.',
      'Coaching is brief and action-oriented — no exploration.',
      'No new projects or scope additions during the sprint.',
      'A recovery day is mandatory after the sprint ends.',
    ],
    exitProtocol: 'Auto-exits at the declared end date, or when you declare the sprint complete. A recovery day follows before standard execution resumes.',
    todayEffect: 'Today shows only the foreground project and fixed commitments; other items move to maintenance.',
  },
  recovery: {
    key: 'recovery',
    name: 'Recovery',
    purpose: 'Preserve continuity during low capacity without shame or catch-up pressure.',
    rules: [
      'Execution scope is reduced to Minimum Viable Day floors.',
      'Coaching is supportive with minimal pressure.',
      'Expectation is maintenance — no judgment.',
      'No catch-up requirements.',
      'No performance evaluation during recovery.',
    ],
    exitProtocol: 'You declare your return; APM confirms and resumes the full agenda the next day. A post-sprint recovery day cannot be shortened.',
    todayEffect: 'Today is reduced to the Minimum Viable Day.',
  },
  deep_work: {
    key: 'deep_work',
    name: 'Deep Work',
    purpose: 'Protect one uninterrupted, high-focus work block.',
    rules: [
      'Block duration is declared up front: 15 minutes to 4 hours.',
      'One task only during the block.',
      'No coaching, check-ins or interruptions during the block.',
      'Agenda is compressed to the one task; everything else moves to after the block.',
    ],
    exitProtocol: 'Auto-exits when the block ends and returns to the mode you were in; you can end it early.',
    todayEffect: 'Today shows only the deep-work task until the block ends.',
  },
};

export const SPRINT_MAX_DAYS = 14;
export const DEEP_WORK_MIN_MINUTES = 15;
export const DEEP_WORK_MAX_MINUTES = 240;

export interface ResumableMode {
  mode: 'standard' | 'high_pressure' | 'sprint';
  startedAt?: string;
  endsAt?: string;
  focus?: string;
}

export interface ModeState {
  mode: OperatingModeKey;
  startedAt?: string;
  /** Sprint end, Deep Work block end, or the moment a declared Recovery return takes effect. */
  endsAt?: string;
  /** Sprint foreground title or the single Deep Work task. */
  focus?: string;
  /** Post-sprint mandatory recovery: no other mode may start before this instant. */
  recoveryLockedUntil?: string;
  /** What Deep Work / Executive Review return to when they end. */
  resume?: ResumableMode;
}

export type ModeRequest =
  | { action: 'enter'; mode: 'standard' | 'high_pressure' | 'executive_review' | 'recovery' }
  | { action: 'enter'; mode: 'sprint'; days: number }
  | { action: 'enter'; mode: 'deep_work'; minutes: number; focus: string }
  | { action: 'exit' };

export type ModeErrorCode =
  | 'recovery_day_required'
  | 'recovery_active'
  | 'sprint_active'
  | 'sprint_needs_foreground'
  | 'invalid_sprint_duration'
  | 'invalid_block_duration'
  | 'deep_work_needs_one_task'
  | 'mode_already_active';

export type ModeEvent =
  | 'mode.entered'
  | 'mode.exited'
  | 'mode.auto_exited'
  | 'sprint.completed'
  | 'sprint.recovery_started'
  | 'recovery.return_declared'
  | 'recovery.resumed';

export type ModeTransition =
  | { ok: true; state: ModeState; events: ModeEvent[] }
  | { ok: false; error: ModeErrorCode; message: string };

export interface ModeContext {
  now: Date;
  timezone?: string;
  foregroundTitle?: string;
}

// ---------- timezone-correct local-day arithmetic (no dependencies) ----------

function safeZone(timezone?: string): string {
  if (!timezone) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return timezone; } catch { return 'UTC'; }
}

function zoneOffsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function localDate(instant: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(timezone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function startOfLocalDay(date: string, timezone?: string): Date {
  const zone = safeZone(timezone);
  const guess = Date.parse(`${date}T00:00:00.000Z`);
  let instant = guess - zoneOffsetMs(guess, zone);
  const corrected = guess - zoneOffsetMs(instant, zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

export function startOfNextLocalDay(instant: Date, timezone?: string): Date {
  return startOfLocalDay(addDays(localDate(instant, timezone), 1), timezone);
}

/** The mandatory post-sprint recovery covers at least 24 hours and ends at a local midnight. */
export function postSprintRecoveryEnd(sprintEnd: Date, timezone?: string): Date {
  return startOfNextLocalDay(new Date(sprintEnd.getTime() + 86_400_000 - 1), timezone);
}

// ---------- transitions ----------

const iso = (value: Date) => value.toISOString();
const isAfter = (value: string | undefined, now: Date) => value !== undefined && Date.parse(value) > now.getTime();

function recoveryAfterSprint(sprintEnd: Date, timezone?: string): ModeState {
  const lockedUntil = iso(postSprintRecoveryEnd(sprintEnd, timezone));
  return { mode: 'recovery', startedAt: iso(sprintEnd), endsAt: lockedUntil, recoveryLockedUntil: lockedUntil, resume: { mode: 'standard' } };
}

function resumable(state: ModeState): ResumableMode {
  if (state.mode === 'sprint') return { mode: 'sprint', startedAt: state.startedAt, endsAt: state.endsAt, focus: state.focus };
  if (state.mode === 'high_pressure') return { mode: 'high_pressure', startedAt: state.startedAt };
  return { mode: 'standard' };
}

function fromResume(resume: ResumableMode | undefined): ModeState {
  if (!resume || resume.mode === 'standard') return { mode: 'standard' };
  return { mode: resume.mode, startedAt: resume.startedAt, endsAt: resume.endsAt, focus: resume.focus };
}

export function transitionMode(current: ModeState, request: ModeRequest, context: ModeContext): ModeTransition {
  const { now, timezone } = context;
  const state = reconcileModeState(current, now, timezone).state;
  const locked = isAfter(state.recoveryLockedUntil, now);

  if (request.action === 'exit') {
    switch (state.mode) {
      case 'standard':
        return { ok: true, state, events: [] };
      case 'sprint':
        return { ok: true, state: recoveryAfterSprint(now, timezone), events: ['sprint.completed', 'sprint.recovery_started'] };
      case 'deep_work':
      case 'executive_review':
        return { ok: true, state: fromResume(state.resume), events: ['mode.exited'] };
      case 'high_pressure':
        return { ok: true, state: { mode: 'standard' }, events: ['mode.exited'] };
      case 'recovery':
        if (locked) return { ok: false, error: 'recovery_day_required', message: `The post-sprint recovery day is mandatory. Standard execution resumes at ${state.recoveryLockedUntil}.` };
        if (state.endsAt) return { ok: true, state, events: [] };
        return {
          ok: true,
          state: { ...state, endsAt: iso(startOfNextLocalDay(now, timezone)), resume: { mode: 'standard' } },
          events: ['recovery.return_declared'],
        };
    }
  }

  const target = request.mode;
  if (target === state.mode) {
    if (target === 'standard') return { ok: true, state, events: [] };
    return { ok: false, error: 'mode_already_active', message: `${MODE_LIBRARY[target].name} is already active.` };
  }
  if (locked && target !== 'recovery') {
    return { ok: false, error: 'recovery_day_required', message: `A recovery day is mandatory after a sprint. Other modes are available from ${state.recoveryLockedUntil}.` };
  }
  if (state.mode === 'recovery' && target !== 'recovery') {
    return { ok: false, error: 'recovery_active', message: 'Recovery is active. Declare your return first — the full agenda resumes the next day.' };
  }
  if (state.mode === 'sprint' && target !== 'deep_work' && target !== 'recovery') {
    return { ok: false, error: 'sprint_active', message: `Sprint is active until ${state.endsAt}. Declare the sprint complete first, or start a Deep Work block inside it.` };
  }

  switch (target) {
    case 'standard':
      return { ok: true, state: { mode: 'standard' }, events: ['mode.exited'] };
    case 'high_pressure':
      return { ok: true, state: { mode: 'high_pressure', startedAt: iso(now) }, events: ['mode.entered'] };
    case 'executive_review':
      return { ok: true, state: { mode: 'executive_review', startedAt: iso(now), resume: resumable(state) }, events: ['mode.entered'] };
    case 'recovery':
      if (state.mode === 'sprint') return { ok: true, state: recoveryAfterSprint(now, timezone), events: ['sprint.completed', 'sprint.recovery_started'] };
      return { ok: true, state: { mode: 'recovery', startedAt: iso(now) }, events: ['mode.entered'] };
    case 'sprint': {
      const days = (request as { days: number }).days;
      if (!Number.isInteger(days) || days < 1 || days > SPRINT_MAX_DAYS) {
        return { ok: false, error: 'invalid_sprint_duration', message: `A sprint is declared for 1–${SPRINT_MAX_DAYS} days.` };
      }
      if (!context.foregroundTitle) {
        return { ok: false, error: 'sprint_needs_foreground', message: 'A sprint runs on one foreground project. Set your foreground first.' };
      }
      const endsAt = startOfLocalDay(addDays(localDate(now, timezone), days), timezone);
      return { ok: true, state: { mode: 'sprint', startedAt: iso(now), endsAt: iso(endsAt), focus: context.foregroundTitle.slice(0, 200) }, events: ['mode.entered'] };
    }
    case 'deep_work': {
      const { minutes, focus } = request as { minutes: number; focus: string };
      if (!Number.isInteger(minutes) || minutes < DEEP_WORK_MIN_MINUTES || minutes > DEEP_WORK_MAX_MINUTES) {
        return { ok: false, error: 'invalid_block_duration', message: `A Deep Work block is ${DEEP_WORK_MIN_MINUTES}–${DEEP_WORK_MAX_MINUTES} minutes.` };
      }
      const task = (focus ?? '').trim();
      if (!task || task.length > 200 || !isExecutableActionTitle(task)) {
        return { ok: false, error: 'deep_work_needs_one_task', message: 'Name the one physical task for this block (for example “Draft the intro section”), not “work on X”.' };
      }
      const resume = state.mode === 'deep_work' ? state.resume : resumable(state);
      return { ok: true, state: { mode: 'deep_work', startedAt: iso(now), endsAt: iso(new Date(now.getTime() + minutes * 60_000)), focus: task, resume }, events: ['mode.entered'] };
    }
  }
}

/** Auto-exit: Deep Work at block end, Sprint at its end date (→ mandatory recovery), declared/post-sprint Recovery at its resume moment. */
export function reconcileModeState(current: ModeState, now: Date, timezone?: string): { state: ModeState; changed: boolean; events: ModeEvent[] } {
  let state = current;
  const events: ModeEvent[] = [];
  for (let step = 0; step < 4; step += 1) {
    if (!state.endsAt || Date.parse(state.endsAt) > now.getTime()) break;
    const endedAt = new Date(state.endsAt);
    if (state.mode === 'deep_work') { state = fromResume(state.resume); events.push('mode.auto_exited'); continue; }
    if (state.mode === 'sprint') { state = recoveryAfterSprint(endedAt, timezone); events.push('mode.auto_exited', 'sprint.recovery_started'); continue; }
    if (state.mode === 'recovery') { state = fromResume(state.resume); events.push('recovery.resumed'); continue; }
    break;
  }
  return { state, changed: events.length > 0, events };
}

// ---------- effect on Today ----------

export interface TodayModeEffect {
  mode: OperatingModeKey;
  summary: string;
  heldBlocks: DailyPlanBlock[];
  heldUntil?: string;
}

function foregroundProject(graph: LifeGraphSnapshot) {
  return graph.projects.find((project) => project.foreground && project.status === 'active');
}

export function applyModeToPlan(plan: DailyPlan, graph: LifeGraphSnapshot, state: ModeState): { plan: DailyPlan; effect: TodayModeEffect } {
  if (state.mode === 'deep_work' && state.focus) {
    const focusBlock: DailyPlanBlock = { id: 'deep_work:focus', title: state.focus, startAt: state.startedAt, endAt: state.endsAt, source: 'methodology' };
    return {
      plan: { ...plan, mode: 'deep_work', blocks: [focusBlock] },
      effect: { mode: 'deep_work', summary: `Deep Work: only “${state.focus}” until the block ends. Everything else moves to after the block.`, heldBlocks: plan.blocks, heldUntil: state.endsAt },
    };
  }
  if (state.mode === 'sprint') {
    const project = foregroundProject(graph);
    const projectActionIds = new Set(graph.nextActions.filter((action) => project && action.projectId === project.id).map((action) => action.id));
    const sprintCritical = (block: DailyPlanBlock) =>
      block.source === 'calendar'
      || (project?.goalId !== undefined && block.goalId === project.goalId)
      || (block.actionId !== undefined && projectActionIds.has(block.actionId));
    const kept = plan.blocks.filter(sprintCritical);
    const held = plan.blocks.filter((block) => !sprintCritical(block));
    return {
      plan: { ...plan, mode: 'sprint', blocks: kept },
      effect: { mode: 'sprint', summary: `Sprint: one foreground — ${state.focus ?? project?.title ?? 'your foreground project'}. ${held.length} other item(s) moved to maintenance.`, heldBlocks: held, heldUntil: state.endsAt },
    };
  }
  if (state.mode === 'recovery') {
    return {
      plan: { ...plan, mode: 'recovery' },
      effect: { mode: 'recovery', summary: 'Recovery: Minimum Viable Day floors only. No catch-up, no evaluation.', heldBlocks: [], heldUntil: state.recoveryLockedUntil ?? state.endsAt },
    };
  }
  return { plan: { ...plan, mode: state.mode }, effect: { mode: state.mode, summary: MODE_LIBRARY[state.mode].todayEffect, heldBlocks: [] } };
}

/** What the client may offer next; the server re-validates every request through `transitionMode`. */
export function modeView(state: ModeState, now: Date) {
  const locked = isAfter(state.recoveryLockedUntil, now);
  return {
    ...state,
    definition: MODE_LIBRARY[state.mode],
    recoveryLocked: locked,
    canExit: state.mode !== 'standard' && !(state.mode === 'recovery' && (locked || state.endsAt !== undefined)),
  };
}
