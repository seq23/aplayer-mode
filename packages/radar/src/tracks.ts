import type { LifeGraphSnapshot, RadarItem, TrackKey } from '@apm/domain';

/**
 * Track RULES on Radar (docs research "deterministic enforcement in app", reason codes
 * body.* / wealth.* / home.* plus the BHPC Tracks). Tracks are filters, not task lists:
 * each item names what the active Track must challenge, with the evidence behind it.
 */

const DAY_MS = 86_400_000;
const COMPENSATION = /\b(double|twice as|extra|make up|makeup|catch[- ]?up|skip (a |the )?(meal|breakfast|lunch|dinner)|fast(ing)?|punish|burn (it )?off)\b/i;
const AUTOMATION = /\b(auto(matic)?|transfer|saving|savings|debt|loan|card) ?(payment|transfer|deposit|saving)?s?\b/i;

function item(graph: LifeGraphSnapshot, now: Date, input: {
  rule: string; track: TrackKey; type: RadarItem['type']; severity: RadarItem['severity']; headline: string; summary: string; ref: string; urgency?: number;
}): RadarItem {
  const at = now.toISOString();
  return {
    id: `radar:${input.rule}:${input.ref}`, userId: graph.identity.userId, type: input.type, headline: input.headline, summary: input.summary,
    status: 'open', severity: input.severity, confidence: 1, importance: 0.8, urgency: input.urgency ?? 0.7, goalAlignment: 0.9, consequence: 0.75,
    sourceRefs: [{ sourceType: 'system', sourceRef: input.ref, label: `Track rule (${input.track})` }],
    reasonCodes: [input.rule, `track.${input.track}`], createdAt: at, firstRelevantAt: at,
  };
}

const overlaps = (a: { startsAt?: string; endsAt?: string }, b: { startsAt?: string; endsAt?: string }) =>
  Boolean(a.startsAt && a.endsAt && b.startsAt && b.endsAt && Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt));

function localMinutes(iso: string, timezone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    return Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  } catch {
    const d = new Date(iso); return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

export function trackRadarItems(graph: LifeGraphSnapshot, now: Date): RadarItem[] {
  const active = new Set((graph.tracks ?? []).filter((track) => track.active).map((track) => track.key));
  const settings = graph.personalOS?.trackSettings ?? {};
  const items: RadarItem[] = [];
  const lifeAdmin = (graph.lifeAdminItems ?? []).filter((entry) => !['completed', 'cancelled'].includes(entry.status));

  if (active.has('wealth_foundation')) {
    const automated = lifeAdmin.some((entry) => entry.recurrence?.frequency && (entry.details?.tag === 'savings_transfer' || entry.details?.tag === 'debt_payment' || AUTOMATION.test(entry.title)));
    if (!automated) {
      items.push(item(graph, now, { rule: 'wealth.no_automation', track: 'wealth_foundation', type: 'opportunity', severity: 'medium', ref: graph.identity.userId,
        headline: 'Set the automatic transfer: amount, account, date', summary: 'Wealth Foundation: saving happens before spending, not from what is left over. No recurring transfer or debt payment exists yet.' }));
    }
    for (const sub of lifeAdmin.filter((entry) => entry.kind === 'subscription' && now.getTime() - Date.parse(entry.createdAt) <= 7 * DAY_MS)) {
      items.push(item(graph, now, { rule: 'wealth.leak_review', track: 'wealth_foundation', type: 'recurring', severity: 'medium', ref: sub.id,
        headline: `Review the new subscription “${sub.title}” this week`, summary: 'A new recurring charge gets a 7-day review: is it still earning its place?' }));
    }
    const firstDebt = settings.debtOrder?.[0];
    if (firstDebt) {
      for (const bill of lifeAdmin.filter((entry) => entry.kind === 'bill' && typeof entry.details?.debtAccount === 'string' && entry.details.debtAccount !== firstDebt && entry.details?.extraPayment === true)) {
        items.push(item(graph, now, { rule: 'wealth.debt_order', track: 'wealth_foundation', type: 'conflict', severity: 'medium', ref: bill.id,
          headline: `Extra payment is going to ${String(bill.details.debtAccount)}, not ${firstDebt}`, summary: 'One debt at a time: the order you chose stays until #1 is closed.' }));
      }
    }
  }

  if (active.has('home_front')) {
    const horizon = now.getTime() + 2 * DAY_MS;
    const family = lifeAdmin.filter((entry) => entry.kind === 'family_obligation' && entry.startsAt && Date.parse(entry.startsAt) <= horizon && Date.parse(entry.endsAt ?? entry.startsAt) >= now.getTime());
    for (const event of (graph.calendarEvents ?? []).filter((candidate) => !candidate.deleted && !candidate.allDay && Date.parse(candidate.startsAt) <= horizon && Date.parse(candidate.endsAt) >= now.getTime())) {
      const block = family.find((entry) => overlaps(event, entry));
      if (block) {
        items.push(item(graph, now, { rule: 'home.conflict_ahead', track: 'home_front', type: 'conflict', severity: 'high', ref: `${event.id}:${block.id}`, urgency: 0.9,
          headline: `“${event.title || 'Busy'}” clashes with “${block.title}” — choose now`, summary: 'Home Front: work and family conflicts are decided before the day, never in the moment.' }));
      }
    }
    const stop = settings.hardStop?.match(/^(\d{2}):(\d{2})$/);
    if (stop) {
      const stopMinutes = Number(stop[1]) * 60 + Number(stop[2]);
      const week = (graph.calendarEvents ?? []).filter((event) => !event.deleted && !event.allDay && Date.parse(event.startsAt) >= now.getTime() && Date.parse(event.startsAt) <= now.getTime() + 7 * DAY_MS && localMinutes(event.startsAt, graph.identity.timezone) >= stopMinutes);
      if (week.length) {
        items.push(item(graph, now, { rule: 'home.after_hours', track: 'home_front', type: 'conflict', severity: 'medium', ref: graph.identity.userId,
          headline: `${week.length} work item${week.length === 1 ? '' : 's'} after your ${settings.hardStop} hard stop this week`, summary: 'Work after the hard stop is declared, not drifted into.' }));
      }
    }
  }

  if (active.has('body_foundation') && !graph.personalOS?.bodyReferral) {
    const slip = (graph.diaryEntries ?? []).find((entry) => entry.kind === 'slip' && now.getTime() - Date.parse(entry.createdAt) <= DAY_MS);
    const compensation = slip && [...(graph.nextActions ?? []).filter((a) => a.status === 'open').map((a) => ({ id: a.id, title: a.title })), ...lifeAdmin.map((e) => ({ id: e.id, title: e.title }))].find((entry) => COMPENSATION.test(entry.title));
    if (slip && compensation) {
      items.push(item(graph, now, { rule: 'body.compensation_blocked', track: 'body_foundation', type: 'conflict', severity: 'high', ref: compensation.id,
        headline: 'Next planned meal is the recovery', summary: `One slip is a data point. “${compensation.title}” is compensation — the next normal planned meal or session is the recovery.` }));
    }
  }

  const closed = (graph.dayRecords ?? []).filter((record) => record.verdict).sort((a, b) => b.day.localeCompare(a.day));
  if (active.has('resilience') && closed.length >= 2 && closed[0]!.verdict !== 'full_day' && closed[1]!.verdict !== 'full_day') {
    items.push(item(graph, now, { rule: 'resilience.capacity', track: 'resilience', type: 'slipping', severity: 'medium', ref: closed[0]!.day,
      headline: 'Two lighter days in a row: protect recovery capacity', summary: 'Resilience: Recovery Mode preserves continuity. It is part of execution, not a failure state.' }));
  }

  if (active.has('operator_discipline')) {
    const replans = (graph.dayRecords ?? []).filter((record) => now.getTime() - Date.parse(`${record.day}T12:00:00Z`) <= 7 * DAY_MS).reduce((sum, record) => sum + (record.replans?.length ?? 0), 0);
    if (replans >= 2) {
      items.push(item(graph, now, { rule: 'operator.renegotiation', track: 'operator_discipline', type: 'slipping', severity: 'medium', ref: graph.identity.userId,
        headline: `${replans} mid-day replans this week`, summary: 'Operator Discipline: the morning plan is executed as written. Look at what keeps reopening it.' }));
    }
  }
  return items;
}
