import { CONSUMER_HEALTH_POLICY_VERSION, HEALTH_DATA_GAME_IDS } from '@apm/planning';
import type { ApiEnv } from './env';
import type { AuthenticatedUser } from './auth';
import { serviceRpc, supabaseRest } from './db';

/**
 * The 18+ confirmation and the consumer health data consent (migration 0093, owner 8 Oct 2026).
 * Both are written only through public.apm_record_consent, which stamps the server time.
 *
 * Age: every account route refuses with 403 `age_confirmation_required` until the user has
 * confirmed (the list of routes that stay open is AGE_GATE_OPEN_ROUTES). Health data: without a
 * live grant the database strips health answers from the intake draft, and the routes below
 * strip them from the install payload and refuse the health-only writes.
 */
export const AGE_GATE_VERSION = '2026-10-08';
export { CONSUMER_HEALTH_POLICY_VERSION };

export type HealthDecision = 'granted' | 'declined' | 'withdrawn';
export interface ConsentState {
  ageConfirmedAt: string | null;
  healthData: { decision: HealthDecision; recordedAt: string; policyVersion: string } | null;
}

/**
 * Routes a signed-in person may use before confirming 18+: the confirmation itself, the
 * health-data decision, and the data-rights routes (anyone may export or delete), push
 * unregister at sign-out, and the merge (it carries the anonymous session's confirmation,
 * then checks it).
 */
export const AGE_GATE_OPEN_ROUTES: ReadonlySet<string> = new Set([
  '/v1/consents', '/v1/consents/age', '/v1/consents/health-data',
  '/v1/privacy/export', '/v1/privacy/delete', '/v1/push/unregister', '/v1/intake/draft/merge',
]);

export class AgeConfirmationRequired extends Error {
  constructor() { super('age_confirmation_required'); this.name = 'AgeConfirmationRequired'; }
}

export const AGE_REQUIRED_BODY = {
  error: 'age_confirmation_required',
  message: 'A Player Mode is for adults. Confirm you are 18 or older to continue.',
} as const;
export const HEALTH_REQUIRED_BODY = {
  error: 'health_data_consent_required',
  message: 'This needs your consent to health data. Turn it on in Settings → Privacy → Consumer health data.',
} as const;

const rpc = <T>(env: ApiEnv, token: string, fn: string, args: Record<string, unknown> = {}) =>
  supabaseRest<T>(env, token, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

function normalize(raw: unknown): ConsentState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ConsentState>;
  return { ageConfirmedAt: typeof value.ageConfirmedAt === 'string' ? value.ageConfirmedAt : null, healthData: value.healthData ?? null };
}

export async function getConsentState(env: ApiEnv, accessToken: string): Promise<ConsentState> {
  return normalize(await rpc<unknown>(env, accessToken, 'apm_my_consents'));
}

export async function recordConsent(env: ApiEnv, user: AuthenticatedUser, kind: 'age_18_plus' | 'consumer_health_data', decision: 'confirmed' | HealthDecision): Promise<ConsentState> {
  const state = normalize(await rpc<unknown>(env, user.accessToken, 'apm_record_consent', {
    p_kind: kind, p_decision: decision, p_policy_version: kind === 'age_18_plus' ? AGE_GATE_VERSION : CONSUMER_HEALTH_POLICY_VERSION,
  }));
  if (state.ageConfirmedAt) rememberAge(user.id);
  return state;
}

/** Service role, after both sessions are proven: the account takes the anonymous decisions it lacks. */
export async function carryConsents(env: ApiEnv, fromUserId: string, toUserId: string): Promise<ConsentState> {
  const state = normalize(await serviceRpc<unknown>(env, 'apm_service_carry_consents', { p_from: fromUserId, p_to: toUserId }));
  if (state.ageConfirmedAt) rememberAge(toUserId);
  return state;
}

// A confirmation is permanent, so a positive answer is kept for the isolate's life (bounded).
const confirmed = new Set<string>();
function rememberAge(userId: string) {
  if (confirmed.size > 5000) confirmed.clear();
  confirmed.add(userId);
}
/** Test hook. */
export function forgetAgeConfirmations(): void { confirmed.clear(); }

export async function ageConfirmed(env: ApiEnv, user: AuthenticatedUser): Promise<boolean> {
  if (confirmed.has(user.id)) return true;
  const state = await getConsentState(env, user.accessToken);
  if (state.ageConfirmedAt) rememberAge(user.id);
  return Boolean(state.ageConfirmedAt);
}

export async function healthConsentActive(env: ApiEnv, accessToken: string): Promise<boolean> {
  return (await getConsentState(env, accessToken)).healthData?.decision === 'granted';
}

const HEALTH_GAMES = HEALTH_DATA_GAME_IDS as readonly string[];

/**
 * The install payload without consumer health data: the body context text, the body-safety,
 * in-bed-routine and mental-load answers, and the weight game. (The draft is stripped by the database.)
 */
export function withoutHealthData<T extends { bodyContext?: string; intakeProfile?: { games: string[]; foregroundGame?: string; bodySafety?: unknown; bedRoutine?: unknown; loadBaseline?: unknown } }>(payload: T): T {
  const { bodyContext: _body, ...rest } = payload;
  if (!rest.intakeProfile) return rest as T;
  // loadBaseline is the "How full does your head feel?" 1–10 mental-load score (0094).
  const { bodySafety: _safety, bedRoutine: _bed, loadBaseline: _load, ...profile } = rest.intakeProfile;
  const games = profile.games.filter((game) => !HEALTH_GAMES.includes(game));
  const foregroundGame = profile.foregroundGame && HEALTH_GAMES.includes(profile.foregroundGame) ? undefined : profile.foregroundGame;
  return { ...rest, intakeProfile: { ...profile, games, ...(foregroundGame ? { foregroundGame } : { foregroundGame: undefined }) } } as T;
}
