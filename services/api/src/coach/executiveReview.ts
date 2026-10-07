import type { DailyPlan, LifeGraphSnapshot } from '@apm/domain';
import { activeTrackDefinitions, trackGuidance } from './tracks';

/**
 * Executive Review Mode (BHPC Appendix B, Mode 2), generated deterministically
 * from the Life Graph: no model, no new insights, no re-diagnosis, no questions.
 * Required opening line, a numbered list of 3–7 items covering current
 * priorities, opportunity quality, execution progress and strategic
 * positioning, the required closing line, and one grounding directive.
 */
export const EXECUTIVE_REVIEW_OPENING = 'Here’s what you already know that still makes you better:';
export const EXECUTIVE_REVIEW_CLOSING = 'None of this is new — you’re just being reminded.';
export const EXECUTIVE_REVIEW_MIN_ITEMS = 3;
export const EXECUTIVE_REVIEW_MAX_ITEMS = 7;

export interface ExecutiveReview {
  opening: string;
  items: Array<{ area: 'priorities' | 'opportunity' | 'execution' | 'positioning' | 'laws'; text: string }>;
  closing: string;
  directive: string;
  text: string;
}

const clean = (value: string, max = 160) => {
  const trimmed = value.replace(/\s+/g, ' ').trim().replace(/[?]+/g, '.');
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

const list = (values: string[], max = 3) => values.map((value) => clean(value, 60)).filter(Boolean).slice(0, max).join('; ');

/** Laws the user installed with their Personal OS — used only to reach the 3-item floor. */
const LAW_ITEMS = [
  'Continuity beats intensity: a lighter day executed beats a heavy day abandoned.',
  'Never Miss Twice: one miss is data, and the next day restarts the system.',
  'No catch-up: you never owe yesterday anything.',
];

export function buildExecutiveReview(graph: LifeGraphSnapshot, plan: DailyPlan, now = new Date()): ExecutiveReview {
  const items: ExecutiveReview['items'] = [];
  const os = graph.personalOS;
  const foreground = graph.projects.find((project) => project.foreground && project.status === 'active');
  const activeGoals = graph.goals.filter((goal) => goal.status === 'active');

  // Current priorities
  if (foreground) {
    items.push({ area: 'priorities', text: `Your foreground is ${clean(foreground.title, 80)}${foreground.objective && foreground.objective !== foreground.title ? ` — ${clean(foreground.objective, 80)}` : ''}. Everything else stays in maintenance.` });
  } else if (activeGoals[0]) {
    items.push({ area: 'priorities', text: `Your top goal is ${clean(activeGoals[0].title, 100)}. One foreground gets aggressive advancement; the rest is maintenance.` });
  }

  // Track filters that apply to ALL guidance (Billionaire Mindset, Appendix A Track 1)
  // frame the review's opportunity evaluation too; placed early so the bound keeps them.
  for (const line of trackGuidance(graph.tracks, [])) items.push({ area: 'opportunity', text: line });

  // Opportunity quality
  if (activeGoals.length) {
    const onTrack = activeGoals.filter((goal) => goal.health === 'on_track').length;
    const atRisk = activeGoals.filter((goal) => goal.health === 'at_risk' || goal.health === 'stalled').map((goal) => goal.title);
    items.push({
      area: 'opportunity',
      text: atRisk.length
        ? `${onTrack} of ${activeGoals.length} active goal(s) are on track. ${list(atRisk, 2)} need protection, not new goals beside them.`
        : `${onTrack} of ${activeGoals.length} active goal(s) are on track. The portfolio you chose is already the plan.`,
    });
  }

  // Execution progress (last 7 local days of closed days and evidence)
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const recentDays = graph.dayRecords.filter((day) => Date.parse(`${day.day}T12:00:00.000Z`) >= weekAgo);
  const recentEvidence = graph.evidence.filter((entry) => Date.parse(entry.createdAt) >= weekAgo);
  if (recentDays.length || recentEvidence.length) {
    const count = (verdict: 'full_day' | 'mvd' | 'miss') => recentDays.filter((day) => day.verdict === verdict).length;
    const days = recentDays.length
      ? `In the last 7 days you closed ${recentDays.length} day(s): ${count('full_day')} full, ${count('mvd')} minimum-viable, ${count('miss')} missed.`
      : '';
    const evidence = recentEvidence.length
      ? `You logged ${recentEvidence.length} piece(s) of completion evidence${recentEvidence[0] ? `, most recently “${clean(recentEvidence[0].summary, 70)}”` : ''}.`
      : '';
    items.push({ area: 'execution', text: [days, evidence, 'Continuity is the metric, and it is on the record.'].filter(Boolean).join(' ') });
  }

  // Strategic positioning
  if (os?.northStar) items.push({ area: 'positioning', text: `Your north star is already written: ${clean(os.northStar, 120)}.` });
  else if (graph.identity.becoming) items.push({ area: 'positioning', text: `You already named who you are becoming: ${clean(graph.identity.becoming, 120)}.` });
  if (os?.nonNegotiables.length) items.push({ area: 'positioning', text: `Your non-negotiables still hold: ${list(os.nonNegotiables)}.` });
  if (os?.failurePatterns.length) items.push({ area: 'positioning', text: `You already know your failure pattern — ${list(os.failurePatterns, 1)} — and your rules exist to catch it.` });
  const track = activeTrackDefinitions(graph.tracks)[0];
  if (track) items.push({ area: 'positioning', text: `${track.name} is running in the background: ${track.rules[0]}` });

  for (const law of LAW_ITEMS) {
    if (items.length >= EXECUTIVE_REVIEW_MIN_ITEMS) break;
    items.push({ area: 'laws', text: law });
  }
  const bounded = items.slice(0, EXECUTIVE_REVIEW_MAX_ITEMS);

  const directive = plan.numberOneMove
    ? `Grounding directive: ${clean(plan.numberOneMove.title, 120)} — start it now.`
    : 'Grounding directive: write the one physical next action for your foreground on Today, then do it.';

  const text = [
    EXECUTIVE_REVIEW_OPENING,
    ...bounded.map((item, index) => `${index + 1}. ${item.text}`),
    EXECUTIVE_REVIEW_CLOSING,
    directive,
  ].join('\n');

  return { opening: EXECUTIVE_REVIEW_OPENING, items: bounded, closing: EXECUTIVE_REVIEW_CLOSING, directive, text };
}
