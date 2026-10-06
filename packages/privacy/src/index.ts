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

  if (dataClass !== 'public_synthetic' && route.trainingAllowed) {
    return { allowed: false, reason: 'training_not_allowed' };
  }

  if (
    (dataClass === 'private_life' || dataClass === 'highly_sensitive') &&
    route.retention !== 'zero'
  ) {
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

export const NEVER_LLM_FIELD_PATTERNS = [
  /password/i,
  /secret/i,
  /oauth/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
  /api[_-]?key/i,
  /credential/i,
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
