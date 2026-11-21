import type { ActionRecord, LifeAdminItem, LifeGraphSnapshot } from '@apm/domain';
import { calendarDateInTimezone, dayStateFromGraph, MOOD_MVD_THRESHOLD } from '@apm/planning';
import { z } from 'zod';
import { executeConnectorAction, type ActionRow } from './actionEngine';
import { freshAgenda } from './dailyLoop';
import { serviceRpc } from './db';
import { activeCalendar, clearSuiteSlot, suiteCalendarSnapshots, suiteSlotOccupied } from './suiteCalendar';
import type { Producer } from './proposalProducers';
import { canWrite, sourceKey } from './proposalProducers';

type Graph = LifeGraphSnapshot;
const DAY = 86_400_000;
const MINUTE = 60_000;
const dateAfter = (day: string, days: number) => new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10);

function dayContext(graph: Graph, now: Date) {
  const timezone = graph.identity.timezone || 'UTC';
  const day = calendarDateInTimezone(now, timezone);
  const record = graph.dayRecords?.find((entry) => entry.day === day);
  const missed = dayStateFromGraph(graph, day, false).state === 'missed_yesterday';
  const hard = record?.mood !== undefined && record.mood <= MOOD_MVD_THRESHOLD
    || record?.dayState === 'recovery' || graph.personalOS?.activeMode === 'recovery';
  return { timezone, day, record, missed, hard };
}

function goalStep(graph: Graph, now: Date) {
  const { day, record, missed, hard } = dayContext(graph, now);
  if (hard || missed || record?.closedAt || graph.personalOS?.activeMode === 'deep_work' || !graph.goalPlans?.length) return;
  const agenda = freshAgenda(graph, { date: day, state: 'normal', mood: record?.mood });
  const step = agenda.firstHour.priority;
  if (agenda.mode !== 'standard' || agenda.safety.referral || !step?.planId || !step.goalId || !step.actionKey
    || step.scope !== 'standard' || step.status !== 'open' || !step.durationMinutes || !step.output
    || step.reasonCodes.includes('pre_start') || step.reasonCodes.includes('day_90_decision')) return;
  return { ...step, planId: step.planId, goalId: step.goalId, actionKey: step.actionKey, durationMinutes: step.durationMinutes, output: step.output,
    setup: step.reasonCodes.includes('setup'), checkedIn: Boolean(record?.checkedInAt), day };
}

export const goalChecklist: Producer['propose'] = async function* ({ graph, now, seen }) {
  const step = goalStep(graph, now);
  if (!step?.setup) return;
  const key = await sourceKey('goal_checklist', step.planId, step.actionKey);
  if (seen.has(key)) return;
  yield {
    key, reason: 'Get a goal step ready',
    payload: { provider: 'apm', planId: step.planId, goalId: step.goalId, actionKey: step.actionKey, day: step.day,
      title: `Get ready to: ${step.title}`, detail: step.output, expiresAt: new Date(now.getTime() + DAY).toISOString() },
  };
  return undefined;
};

export const goalCalendar: Producer['propose'] = async function* ({ graph, now, seen, reserved }) {
  const step = goalStep(graph, now);
  if (!step || step.setup || !step.checkedIn) return;
  const accounts = graph.connections.filter((entry) => canWrite(entry, 'calendar'));
  const account = accounts.find((entry) => entry.isPrimary) ?? accounts[0];
  if (!account) return 'GOAL_CALENDAR_CONNECTOR_MISSING_OR_READ_ONLY';
  const key = await sourceKey('goal_calendar', step.planId, step.actionKey, step.day);
  if (seen.has(key) || graph.calendarEvents.some((event) => !event.deleted && event.title === step.title
    && calendarDateInTimezone(event.startsAt, graph.identity.timezone) === step.day)) return;
  if (graph.personalOS?.hardBoundaries?.length) return 'GOAL_CALENDAR_NO_SAFE_SLOT';
  const slot = clearSuiteSlot(graph, now.getTime() + 30 * MINUTE, step.durationMinutes * MINUTE, step.day, step.day, reserved);
  if (!slot) return 'GOAL_CALENDAR_NO_SAFE_SLOT';
  yield {
    key, reason: 'Make time for a goal step',
    payload: { ...slot, expiresAt: slot.startsAt, title: step.title, detail: step.output, planId: step.planId,
      goalId: step.goalId, actionKey: step.actionKey, day: step.day, timezone: graph.identity.timezone || 'UTC',
      connectionId: account.id, provider: account.provider, account: account.label ?? account.accountLabel ?? account.provider },
  };
};

function canDefer(item: LifeAdminItem) {
  return (item.kind === 'shopping' || item.kind === 'meal_plan')
    && ['open', 'planned', 'scheduled'].includes(item.status) && item.importance <= 3
    && item.details.flexibleSchedule === true && item.provenance.kind === 'stated' && item.provenance.sourceType === 'manual'
    && !item.personId && item.amountMinor === undefined && !item.currency && !item.dueAt && !Object.keys(item.recurrence).length
    && Boolean(item.startsAt);
}

export function deferAdmin(kind: 'missed_day' | 'hard_day'): Producer['propose'] {
  return async function* ({ graph, now, seen, reserved }) {
    const { day, timezone, hard, missed, record } = dayContext(graph, now);
    if (record?.closedAt || (kind === 'hard_day' ? !hard : !missed)) return;
    const previous = dateAfter(day, -1);
    const earliest = dateAfter(day, 1);
    let noSlot = false;
    for (const item of [...graph.lifeAdminItems].sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? '') || a.id.localeCompare(b.id))) {
      if (!canDefer(item)) continue;
      const originalDay = calendarDateInTimezone(item.startsAt!, timezone);
      if (originalDay !== day && !(kind === 'missed_day' && originalDay === previous)) continue;
      // Both triggers can apply on the same day. One decision per scheduled occurrence.
      const key = await sourceKey('admin_defer', item.id, new Date(item.startsAt!).toISOString());
      if (seen.has(key)) continue;
      const span = item.endsAt ? Date.parse(item.endsAt) - Date.parse(item.startsAt!) : 0;
      const slot = clearSuiteSlot(graph, Date.parse(earliest) - DAY / 2, span || 30 * MINUTE, earliest, dateAfter(day, 7), reserved, true);
      if (!slot) { noSlot = true; continue; }
      reserved.push(slot);
      yield {
        key, reason: kind === 'hard_day' ? 'Take a task off a hard day' : 'Make room on a minimum day',
        payload: { provider: 'apm', itemId: item.id, expectedUpdatedAt: item.updatedAt, startsAt: slot.startsAt,
          endsAt: item.endsAt ? new Date(Date.parse(slot.startsAt) + span).toISOString() : null,
          originalStartsAt: item.startsAt, originalEndsAt: item.endsAt, title: item.title, day, timezone,
          expiresAt: new Date(now.getTime() + DAY).toISOString() },
      };
    }
    return noSlot ? 'NO_SAFE_LIFE_ADMIN_SLOT' : undefined;
  };
}

function assertCurrent(action: ActionRecord, graph: Graph, now: Date) {
  const payload = action.payload;
  const context = dayContext(graph, now);
  if (payload.day !== context.day || Date.parse(String(payload.expiresAt)) <= now.getTime() || context.record?.closedAt) {
    throw new Error('action_proposal_stale');
  }
  if (payload.suiteProposal === 'goal_calendar' || payload.suiteProposal === 'goal_checklist') {
    const step = goalStep(graph, now);
    if (!step || step.planId !== payload.planId || step.goalId !== payload.goalId || step.actionKey !== payload.actionKey
      || step.setup !== (payload.suiteProposal === 'goal_checklist')
      || payload.title !== (step.setup ? `Get ready to: ${step.title}` : step.title) || payload.detail !== step.output) {
      throw new Error('action_proposal_stale');
    }
    return step;
  }
  const item = graph.lifeAdminItems.find((entry) => entry.id === payload.itemId);
  if (!item || !canDefer(item) || item.updatedAt !== payload.expectedUpdatedAt || item.startsAt !== payload.originalStartsAt
    || (payload.suiteProposal === 'hard_day' ? !context.hard : !context.missed)) throw new Error('action_proposal_stale');
  const startsAt = String(payload.startsAt);
  const endsAt = typeof payload.endsAt === 'string' ? payload.endsAt : new Date(Date.parse(startsAt) + 30 * MINUTE).toISOString();
  if (suiteSlotOccupied({ startsAt, endsAt }, graph.calendarEvents, graph)) throw new Error('action_proposal_stale');
}

const goalBlock = z.object({ connectionId: z.uuid(), title: z.string().min(1).max(500), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() });

export async function executeGoalCalendar(action: ActionRecord, graph: Graph, input: Parameters<typeof executeConnectorAction>[1], now: Date) {
  const step = assertCurrent(action, graph, now);
  const slot = goalBlock.parse(action.payload);
  const calendars = graph.connections.filter(activeCalendar);
  const target = calendars.find((entry) => entry.id === slot.connectionId && canWrite(entry, 'calendar'));
  const start = Date.parse(slot.startsAt);
  const end = Date.parse(slot.endsAt);
  if (!step?.checkedIn || start <= now.getTime() || end - start !== step.durationMinutes * MINUTE
    || !target || graph.personalOS?.hardBoundaries?.length) throw new Error('action_proposal_stale');
  const snapshots = await suiteCalendarSnapshots(calendars, input, slot.startsAt, slot.endsAt);
  const events = [...snapshots.flatMap((snapshot) => snapshot.events), ...graph.calendarEvents.filter((event) => event.provider === 'device')];
  if (suiteSlotOccupied(slot, events, graph)) throw new Error('action_proposal_stale');
  const receipt = await executeConnectorAction(action, input);
  if (!receipt) throw new Error('calendar_create_receipt_missing');
  return receipt;
}

export function applySuiteLifeGraph(action: ActionRecord, graph: Graph, input: Parameters<typeof executeConnectorAction>[1], now: Date) {
  assertCurrent(action, graph, now);
  return serviceRpc<ActionRow>(input.env, 'apm_service_apply_suite_life_graph', { p_user_id: input.userId, p_action_id: action.id });
}
