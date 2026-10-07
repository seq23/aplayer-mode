import { AREA_KEYS, AREA_LABELS, AREA_PILLAR, PILLAR_NAMES, type AreaKey, type PillarName } from '@apm/domain';
import type { PillarReviewEntry, PillarScore } from './daily-loop.js';

/**
 * Three pillars, areas inside them (owner decision 7 Oct 2026). The engine scores AREAS
 * (critical/flexible, floors, MVD); the user sees the roll-up: "Mind ✓ Body ✓ Spirit –".
 */

/** Persona label for the work area ("Business", "Career", "Studies", "Craft"…). */
export const WORK_AREA_LABELS: Readonly<Record<string, string>> = {
  founder: 'Business', operator: 'Career', student: 'Studies', creator: 'Craft', transition: 'Transition', athlete: 'Training',
};

export function areaLabel(area: AreaKey, foregroundGame?: string): string {
  if (area === 'work' && foregroundGame && WORK_AREA_LABELS[foregroundGame]) return WORK_AREA_LABELS[foregroundGame]!;
  return AREA_LABELS[area];
}

/**
 * Deterministic classification of a pillar the user suggests ("my marriage", "guitar",
 * "church", "my mom's care"). Ordered keyword rules; the first hit wins. Anything unknown
 * becomes Learning under Mind (the user can move it with one tap). An approved model
 * route may only replace this with another valid area (see the API's synthesis step).
 */
const CLASSIFIER: ReadonlyArray<{ area: AreaKey; pattern: RegExp }> = [
  { area: 'faith', pattern: /\b(faith|god|pray\w*|church|mosque|temple|synagogue|bible|scripture|quran|qur'an|torah|worship|ministry|devotion\w*|spiritual\w*)\b/i },
  { area: 'family', pattern: /\b(family|kids?|children|son|daughter|baby|toddler|teen\w*|marriage|husband|wife|spouse|partner|relationship\w*|dating|friend\w*|mom|mum|dad|parent\w*|grand\w*|siblings?|brother|sister|caregiv\w*|elder ?care)\b/i },
  { area: 'service', pattern: /\b(volunteer\w*|service|serve|charity|giving|donat\w*|community work|mentor\w*)\b/i },
  { area: 'meditation', pattern: /\b(meditat\w*|mindful\w*|breath\w*|calm|stillness|yoga nidra)\b/i },
  { area: 'gratitude', pattern: /\b(gratitude|grateful|thankful\w*)\b/i },
  { area: 'nature', pattern: /\b(nature|outdoors?|outside|hik\w*|garden\w*|forest|beach|sunlight|park)\b/i },
  { area: 'sleep', pattern: /\b(sleep\w*|bedtime|insomnia|rest(ing)?|nap\w*)\b/i },
  { area: 'food', pattern: /\b(food|eat\w*|meal\w*|cook\w*|nutrition|hydrat\w*|water|diet)\b/i },
  { area: 'weight', pattern: /\b(weight|lbs?|pounds|kg|scale)\b/i },
  { area: 'health_routines', pattern: /\b(medication|meds|vitamins?|physio\w*|doctor|appointments?|health|recovery|rehab|injur\w*|chronic)\b/i },
  { area: 'movement', pattern: /\b(gym|workout\w*|exercis\w*|fitness|run\w*|walk\w*|lift\w*|sport\w*|train\w*|swim\w*|cycl\w*|pilates|yoga|stretch\w*|dance)\b/i },
  { area: 'mental_health', pattern: /\b(therap\w*|counsel\w*|mental health|anxiety|journal\w*|stress|burn ?out|emotion\w*|grief)\b/i },
  { area: 'focus', pattern: /\b(focus|phone|screen\w*|scroll\w*|social media|distraction\w*|attention|deep work)\b/i },
  { area: 'money', pattern: /\b(money|financ\w*|budget\w*|sav(e|ing|ings)|debt|invest\w*|wealth|retire\w*|bills?|income|tax\w*|loans?|mortgage|rent|side hustle)\b/i },
  { area: 'work', pattern: /\b(work|job|career|business|startup|company|clients?|sales|promotion|team|boss|project\w*|launch|hiring|fundrais\w*|study|studies|exam|school|college|thesis)\b/i },
  { area: 'learning', pattern: /\b(learn\w*|read\w*|books?|course\w*|skill\w*|language|music|guitar|piano|art|paint\w*|writ\w*|craft|hobby|photograph\w*)\b/i },
];

export interface SuggestedAreaClassification {
  label: string;
  area: AreaKey;
  pillar: PillarName;
  /** `keyword` when a rule matched, `default` when nothing matched. */
  by: 'keyword' | 'default';
}

export function classifySuggestedArea(text: string): SuggestedAreaClassification {
  const label = text.trim().replace(/\s+/g, ' ').slice(0, 60);
  const hit = CLASSIFIER.find(({ pattern }) => pattern.test(label));
  const area = hit?.area ?? 'learning';
  return { label, area, pillar: AREA_PILLAR[area], by: hit ? 'keyword' : 'default' };
}

/** Moving a suggested area is one tap: any valid area key, nothing else. */
export function moveSuggestedArea(item: { label: string }, area: string): SuggestedAreaClassification | undefined {
  if (!(AREA_KEYS as readonly string[]).includes(area)) return undefined;
  const key = area as AreaKey;
  return { label: item.label, area: key, pillar: AREA_PILLAR[key], by: 'keyword' };
}

export type PillarRollUp = PillarScore | 'none';

/**
 * Roll the area review up to the three pillars. A pillar with critical areas is a hit only
 * when every critical area hit (partial counts on a recovery day); with no critical area it
 * takes its best area score. A pillar with nothing reviewed (or switched off) is `none`.
 */
export function rollUpPillars(
  review: PillarReviewEntry[],
  criticalAreas: AreaKey[],
  options: { recovery?: boolean; enabled?: PillarName[] } = {},
): Record<PillarName, PillarRollUp> {
  const out = {} as Record<PillarName, PillarRollUp>;
  for (const pillar of PILLAR_NAMES) {
    if (options.enabled && !options.enabled.includes(pillar)) { out[pillar] = 'none'; continue; }
    const entries = review.filter((entry) => AREA_PILLAR[entry.pillar] === pillar);
    const critical = criticalAreas.filter((area) => AREA_PILLAR[area] === pillar);
    if (!entries.length && !critical.length) { out[pillar] = 'none'; continue; }
    const scoreOf = (area: AreaKey): PillarScore => entries.find((entry) => entry.pillar === area)?.score ?? 'miss';
    if (critical.length) {
      const scores = critical.map(scoreOf);
      const ok = (s: PillarScore) => s === 'hit' || (options.recovery === true && s === 'partial');
      out[pillar] = scores.every(ok) ? 'hit' : scores.some((s) => s !== 'miss') ? 'partial' : 'miss';
    } else {
      const scores = entries.map((entry) => entry.score);
      out[pillar] = scores.includes('hit') ? 'hit' : scores.includes('partial') ? 'partial' : 'miss';
    }
  }
  return out;
}

const SYMBOL: Readonly<Record<PillarRollUp, string>> = { hit: '✓', partial: '½', miss: '✗', none: '–' };

/** "Mind ✓ Body ✓ Spirit –" */
export function formatPillarRollUp(rollUp: Record<PillarName, PillarRollUp>): string {
  return PILLAR_NAMES.map((pillar) => `${pillar[0]!.toUpperCase()}${pillar.slice(1)} ${SYMBOL[rollUp[pillar]]}`).join(' ');
}
