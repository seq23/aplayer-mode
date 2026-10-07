/**
 * The not-therapy boundary (BHPC Part I "Coaching is not therapy"; APP-INTENT
 * "safety boundary in coaching policy"). Deterministic and checked BEFORE any
 * model call, on every message, in every mode and phase:
 *   - crisis      → coaching stops for the session and crisis resources are shown;
 *   - medical     → coaching stops (Body Foundation red flags) and a clinician referral is shown;
 *   - therapy_scope → a short boundary note, then normal behavioral coaching continues.
 * Ordinary performance idioms ("this deadline is killing me") are not crisis language.
 */
export type SafetyLevel = 'none' | 'therapy_scope' | 'medical' | 'crisis';

export interface SafetyResource {
  label: string;
  detail: string;
  action?: { kind: 'call' | 'text' | 'url'; value: string };
}

export interface SafetyAssessment {
  level: SafetyLevel;
  /** Pattern ids only — never the user's words — so this is safe to audit. */
  signals: string[];
}

const CRISIS_PATTERNS: Array<[string, RegExp]> = [
  ['suicide', /\bsuicid\w*/i],
  ['kill_self', /\b(kill|hurt|harm)(ing)? my ?self\b/i],
  ['end_life', /\b(end(ing)? my life|end it all|take my (own )?life)\b/i],
  ['want_to_die', /\b(want(ed)? to die|wish i (was|were) dead|better off dead|better off without me)\b/i],
  ['no_reason_to_live', /\b(no reason to live|don'?t want to (live|be alive|be here anymore|wake up))\b/i],
  ['self_harm', /\b(self[- ]?harm\w*|cut(ting)? myself|overdos\w*)\b/i],
  ['unsafe_at_home', /\b(not safe at home|(he|she|they|my partner|my husband|my wife|my boyfriend|my girlfriend) (hits|hit|beats|beat|chokes|choked) me|being abused|abus(es|ing) me)\b/i],
];

const MEDICAL_PATTERNS: Array<[string, RegExp]> = [
  ['chest_pain', /\bchest pains?\b/i],
  ['fainting', /\b(faint(ed|ing)?|pass(ed|ing) out|blacked out)\b/i],
  ['purging', /\b(purg(e|ed|ing)|making myself (throw up|vomit|sick))\b/i],
  ['extended_fasting', /\b(haven'?t eaten|not eaten|no food) (in|for) (\d+|two|three|four|five|several) days\b/i],
  ['very_low_intake', /\b(under|less than|below) (1,?200|1,?000|[1-9]\d{2}) (calories|kcal|cals)\b/i],
];

const THERAPY_SCOPE_PATTERNS: Array<[string, RegExp]> = [
  ['trauma', /\btrauma\w*\b/i],
  ['diagnosis', /\b(diagnos\w*|do i have (adhd|depression|anxiety|bipolar|ptsd))\b/i],
  ['clinical_terms', /\b(ptsd|depress(ed|ion)|panic attacks?|bipolar|ocd|eating disorder)\b/i],
  ['childhood', /\b(my childhood|abuse as a child|my parents (hurt|abused))\b/i],
  ['grief', /\b(grief|grieving|bereave\w*)\b/i],
];

function matches(patterns: Array<[string, RegExp]>, text: string): string[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

export function assessSafety(raw: string): SafetyAssessment {
  // Normalize typographic apostrophes and spacing so "don’t" and "don't" match alike.
  const text = raw.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ');
  const crisis = matches(CRISIS_PATTERNS, text);
  if (crisis.length) return { level: 'crisis', signals: crisis };
  const medical = matches(MEDICAL_PATTERNS, text);
  if (medical.length) return { level: 'medical', signals: medical };
  const scope = matches(THERAPY_SCOPE_PATTERNS, text);
  if (scope.length) return { level: 'therapy_scope', signals: scope };
  return { level: 'none', signals: [] };
}

export const CRISIS_RESOURCES: SafetyResource[] = [
  { label: '988 Suicide & Crisis Lifeline (US)', detail: 'Call or text 988, any time, free and confidential.', action: { kind: 'call', value: '988' } },
  { label: 'Emergency services', detail: 'If you are in immediate danger, call your local emergency number (911 in the US).', action: { kind: 'call', value: '911' } },
  { label: 'Outside the US', detail: 'Find a free local helpline at findahelpline.com.', action: { kind: 'url', value: 'https://findahelpline.com' } },
];

export const MEDICAL_RESOURCES: SafetyResource[] = [
  { label: 'Emergency services', detail: 'Chest pain, fainting or feeling unsafe in your body: call your local emergency number (911 in the US) now.', action: { kind: 'call', value: '911' } },
  { label: 'Your clinician', detail: 'For eating or health red flags, talk to a doctor before any body goal continues. APM will not coach body goals until a clinician clears it.' },
];

export const CRISIS_MESSAGE = 'I’m stopping coaching here, because what you just shared matters more than any plan. You don’t have to handle this alone. If you might act on these thoughts or you are in danger, reach a crisis line or emergency services now — the resources are below. A licensed professional or someone you trust is the right support for this, not a coaching session.';

export const MEDICAL_MESSAGE = 'I’m stopping coaching here. What you described is a health signal, and coaching is not medical advice. Please get checked — the resources are below. Body goals stay paused until a clinician clears them.';

export const THERAPY_SCOPE_NOTE = 'Quick boundary: coaching here is behavioral and decision-focused — it isn’t therapy, and it won’t diagnose or process that with you. A licensed therapist is the right support for it. If you are ever in crisis, call or text 988 (US) or your local emergency number. What we can do here is choose your next move.';
