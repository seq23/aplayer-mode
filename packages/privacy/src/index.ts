export type DataClass =
  | 'public_synthetic'
  | 'low_personal'
  | 'private_life'
  | 'highly_sensitive'
  | 'secret';

export type RetentionClass = 'zero' | 'limited' | 'unknown';

export interface InferenceRoutePolicy {
  routeId: string;
  trainingAllowed: boolean;
  retention: RetentionClass;
  approvedForHighlySensitive: boolean;
  enabled: boolean;
}

export interface PrivacyDecision {
  allowed: boolean;
  reason:
    | 'allowed'
    | 'route_disabled'
    | 'secret_never_external'
    | 'training_not_allowed'
    | 'zdr_required'
    | 'highly_sensitive_not_approved';
}

export function evaluateInferencePrivacy(
  dataClass: DataClass,
  route: InferenceRoutePolicy,
): PrivacyDecision {
  if (!route.enabled) {
    return { allowed: false, reason: 'route_disabled' };
  }

  if (dataClass === 'secret') {
    return { allowed: false, reason: 'secret_never_external' };
  }

  if (route.trainingAllowed && !mayUseTrainingEnabledRoute(dataClass)) {
    return { allowed: false, reason: 'training_not_allowed' };
  }

  if (requiresZeroDataRetention(dataClass) && route.retention !== 'zero') {
    return { allowed: false, reason: 'zdr_required' };
  }

  if (dataClass === 'highly_sensitive' && !route.approvedForHighlySensitive) {
    return { allowed: false, reason: 'highly_sensitive_not_approved' };
  }

  return { allowed: true, reason: 'allowed' };
}

export function requiresZeroDataRetention(dataClass: DataClass): boolean {
  return dataClass === 'private_life' || dataClass === 'highly_sensitive';
}

export function mayUseTrainingEnabledRoute(dataClass: DataClass): boolean {
  return dataClass === 'public_synthetic';
}

/** Field names that are never sent to a model, whatever their value. */
export const NEVER_LLM_FIELD_PATTERNS = [
  /password|passcode|passphrase/i,
  /secret/i,
  /oauth/i,
  /token/i,
  /authori[sz]ation/i,
  /cookie/i,
  /jwt/i,
  /private[_-]?key/i,
  /api[_-]?key/i,
  /credential/i,
  /session[_-]?(secret|key|token|cookie|id)/i,
  /^otp$|one[_-]?time[_-]?(code|password)/i,
] as const;

export function assertNoSecretKeysInObject(value: unknown, path = 'root'): void {
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_LLM_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(`Secret-like field blocked from AI context: ${path}.${key}`);
    }

    assertNoSecretKeysInObject(child, `${path}.${key}`);
  }
}

/** Credential shapes found in free text (an email body, a pasted note). */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'pem_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  { kind: 'api_key', pattern: /\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g },
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // "password is X" / "password: X", or "password X" when X looks like one (has a digit or symbol).
  { kind: 'password_phrase', pattern: /\b(?:password|passcode|passphrase|pin)\b(?:\s*(?:is|was|:|=)\s*\S+|\s+(?=\S*[\d!@#$%^&*])\S{4,})/gi },
  { kind: 'one_time_code', pattern: /\b(?:verification|security|one[- ]time|login|sign[- ]in|confirmation|access|2fa|otp)\s+(?:code|pin|password)\b\s*(?:is|:|=)?\s*[A-Z0-9]{4,10}\b/gi },
  { kind: 'one_time_code', pattern: /\b\d{4,8}\s+is\s+your\s+(?:[a-z]+\s+){0,3}(?:code|pin|password)\b/gi },
];

const CARD_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export const REDACTED_SECRET = '[redacted secret]';

/** Finds credential shapes in text: what kinds, never the values. */
export function findSecrets(text: string): string[] {
  const kinds = new Set<string>();
  for (const { kind, pattern } of SECRET_VALUE_PATTERNS) if (new RegExp(pattern.source, pattern.flags).test(text)) kinds.add(kind);
  for (const match of text.match(CARD_RUN) ?? []) {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) kinds.add('payment_card');
  }
  return [...kinds];
}

/** Replaces every credential shape with REDACTED_SECRET. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const { pattern } of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), () => { redactions += 1; return REDACTED_SECRET; });
  }
  out = out.replace(CARD_RUN, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { redactions += 1; return REDACTED_SECRET; }
    return match;
  });
  return { text: out, redactions };
}

function redactDeep(value: unknown, counter: { n: number }): unknown {
  if (typeof value === 'string') { const r = redactSecrets(value); counter.n += r.redactions; return r.text; }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, counter));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, counter)]));
  return value;
}

/**
 * The secret guard for one inference request (AGENTS.md: credentials, OAuth tokens and
 * secrets never enter prompts). Secret-named fields anywhere in the context are refused;
 * the developer-authored system/instruction text may never carry a credential (refused);
 * credential shapes in user/source text (a password-reset email, a pasted key) are
 * redacted before anything leaves.
 */
export function guardInferenceText<T extends { system: string; instruction: string; context: unknown }>(task: T): { task: T; redactions: number } {
  assertNoSecretKeysInObject(task.context);
  for (const [name, text] of [['system', task.system], ['instruction', task.instruction]] as const) {
    const found = findSecrets(text);
    if (found.length) throw new Error(`Secret-like value blocked from AI ${name}: ${found.join(', ')}`);
  }
  const counter = { n: 0 };
  const context = redactDeep(task.context, counter);
  return { task: { ...task, context }, redactions: counter.n };
}

// ---------------------------------------------------------------------------
// Sensitivity classification (docs/01: class 3 — financial details, health records,
// children's sensitive information, government IDs). Deterministic; it can only RAISE
// the class a caller declared, never lower it.
// ---------------------------------------------------------------------------

export const HIGHLY_SENSITIVE_PATTERNS: ReadonlyArray<{ kind: 'health' | 'financial' | 'government_id' | 'child'; pattern: RegExp }> = [
  { kind: 'health', pattern: /\b(diagnosed with|my diagnosis|prescription (?:refill|for|is ready|number)|prescribed (?:me|you|him|her)|(?:my|your|his|her) medications?|\d+ ?mg\b|lab (?:results?|report)|blood (?:test|work|panel)|biopsy|mri|ct scan|x-ray|patient portal|medical records?|health record|hiv|hepatitis|cancer|chemotherapy|oncolog\w*|psychiatr\w*|antidepressant|ssri|insulin|std|sti test|pregnan(?:t|cy)|miscarriage|ivf|clinic(?:al)? notes?|discharge summary|eating disorder|anorexi\w*|bulimi\w*|self[- ]harm|suicid\w*)\b/i },
  { kind: 'financial', pattern: /\b(bank statement|account (?:number|no\.?|ending in)|routing number|sort code|iban|available balance|current balance|statement balance|credit score|credit report|tax return|form 1040|w-2|1099|payslip|pay stub|salary of|net worth|loan balance|mortgage (?:statement|balance)|overdraft|wire transfer|brokerage statement)\b/i },
  { kind: 'financial', pattern: /\b(?:acct|account)\s*(?:#|no\.?|number)?\s*:?\s*\d{6,}\b/i },
  { kind: 'government_id', pattern: /\b(\d{3}-\d{2}-\d{4}|social security (?:number|no)|ssn|passport (?:number|no)|driver'?s licen[cs]e (?:number|no)|national insurance number|tax id|itin)\b/i },
  { kind: 'child', pattern: /\b(?:my|our|your)\s+(?:son|daughter|child|kid)(?:'s)?\b[^.]{0,60}\b(diagnos\w*|iep|therapy|therapist|custody|medication|pediatric\w*|special needs|counsel(?:ing|or))\b/i },
];

export function classifySensitivity(texts: string[]): { highlySensitive: boolean; kinds: string[] } {
  const kinds = new Set<string>();
  for (const text of texts) for (const { kind, pattern } of HIGHLY_SENSITIVE_PATTERNS) if (pattern.test(text)) kinds.add(kind);
  return { highlySensitive: kinds.size > 0, kinds: [...kinds] };
}

const DATA_CLASS_RANK: Record<DataClass, number> = { public_synthetic: 0, low_personal: 1, private_life: 2, highly_sensitive: 3, secret: 4 };

/** The class an inference request actually carries: the caller's, raised by the content. */
export function effectiveDataClass(declared: DataClass, texts: string[]): DataClass {
  return classifySensitivity(texts).highlySensitive && DATA_CLASS_RANK[declared] < DATA_CLASS_RANK.highly_sensitive ? 'highly_sensitive' : declared;
}
