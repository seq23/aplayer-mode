import { z } from 'zod';
import type { ApiEnv } from './env';
import { SERVICE_ROLE_TOKEN, SupabaseRestError, supabaseRest } from './db';

/**
 * Phase D billing (docs/33-BILLING-PHASE-D.md). RevenueCat is the receipt verifier for
 * App Store + Google Play + Web Billing. Entitlements change only through ONE writer
 * (applyBillingEvent): the webhook, after the shared Authorization secret is verified here,
 * and reconcile, which reads the session user's subscriptions from RevenueCat itself. The database
 * (migration 0040) maps product -> plan, dedupes on the event id, drops stale events
 * and decides Founding 100. Nothing a client says about a purchase is trusted.
 */

const encoder = new TextEncoder();

/** Shortest webhook secret accepted; a shorter one is treated as not configured (fail closed). */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;
/** RevenueCat events are a few KB; anything this large is not one. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Constant-time check of the RevenueCat Authorization header. Both sides are hashed
 * first, so the comparison is fixed-length and never short-circuits on the first
 * differing byte or on a length difference. Accepts the raw secret or `Bearer <secret>`.
 */
export async function verifyWebhookAuthorization(header: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < MIN_WEBHOOK_SECRET_LENGTH || !header) return false;
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

const shortString = z.string().max(200);
const millis = z.number().int().nonnegative().max(8_640_000_000_000_000);

/** The only RevenueCat fields APM keeps. Subscriber attributes, prices, aliases etc. are dropped. */
const revenueCatEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().regex(/^[A-Z_]{1,64}$/),
  app_user_id: shortString.nullish(),
  product_id: shortString.nullish(),
  new_product_id: shortString.nullish(),
  store: z.string().max(40).nullish(),
  environment: z.string().max(40).nullish(),
  event_timestamp_ms: millis,
  expiration_at_ms: millis.nullish(),
  cancel_reason: z.string().max(64).nullish(),
  period_type: z.string().max(40).nullish(),
});

const revenueCatBodySchema = z.object({ api_version: z.string().max(20).optional(), event: z.record(z.string(), z.unknown()) });

export type SanitizedBillingEvent = z.infer<typeof revenueCatEventSchema>;

/** Picks the allow-listed fields of a RevenueCat webhook body, or undefined when it is not one. */
export function sanitizeRevenueCatEvent(body: unknown): SanitizedBillingEvent | undefined {
  const outer = revenueCatBodySchema.safeParse(body);
  if (!outer.success) return undefined;
  const raw = outer.data.event;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(revenueCatEventSchema.shape)) if (raw[key] !== undefined) picked[key] = raw[key];
  const parsed = revenueCatEventSchema.safeParse(picked);
  if (!parsed.success) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) clean[key] = value;
  return clean as SanitizedBillingEvent;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The explicit tester allowlist (BILLING_SANDBOX_TESTER_IDS): exact, lower-cased UUIDs only. */
export function sandboxTesterIds(env: ApiEnv): ReadonlySet<string> {
  const ids = (env.BILLING_SANDBOX_TESTER_IDS ?? '').split(',').map((id) => id.trim().toLowerCase()).filter((id) => UUID.test(id));
  return new Set(ids);
}

/**
 * May this event's SANDBOX environment be honoured? Staging: every sandbox event
 * (BILLING_ALLOW_SANDBOX=true, refused in production by scripts/deploy-api-production.sh).
 * Production: ONLY a sandbox event whose app_user_id is on the explicit tester allowlist.
 * Anything else stays `ignored_environment` in the database.
 */
export function billingSandboxAllowed(env: ApiEnv, event?: Pick<SanitizedBillingEvent, 'environment' | 'app_user_id'>): boolean {
  if (env.BILLING_ALLOW_SANDBOX === 'true') return true;
  if (!event || event.environment !== 'SANDBOX' || !event.app_user_id) return false;
  return sandboxTesterIds(env).has(event.app_user_id.toLowerCase());
}

export interface BillingApplyResult { outcome: string; replayed: boolean; plan?: string; status?: string }

/**
 * THE one writer of entitlements, shared by the webhook and reconcile: the database function
 * apm_billing_apply_event (idempotent on the event id, drops stale events, maps product -> plan)
 * with the ONE sandbox rule (billingSandboxAllowed). Never a second path that could drift.
 */
export async function applyBillingEvent(env: ApiEnv, event: SanitizedBillingEvent): Promise<BillingApplyResult> {
  return supabaseRest<BillingApplyResult>(env, SERVICE_ROLE_TOKEN, '/rest/v1/rpc/apm_service_billing_apply_event', {
    method: 'POST',
    body: JSON.stringify({ p_event: event, p_allow_sandbox: billingSandboxAllowed(env, event) }),
  });
}

export type WebhookResponse = { status: 200 | 400 | 401 | 413 | 503; body: Record<string, unknown> };

/**
 * The whole webhook, framework-free so it is testable end to end. 2xx only once the
 * event is durably recorded (applied, replayed, or recorded as ignored); a database
 * failure throws, the route answers 500 and RevenueCat retries.
 */
export async function handleRevenueCatWebhook(env: ApiEnv, request: Request): Promise<WebhookResponse> {
  const secret = env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret || secret.length < MIN_WEBHOOK_SECRET_LENGTH || !env.SUPABASE_SECRET_KEY) {
    return { status: 503, body: { error: 'billing_webhook_not_configured' } };
  }
  if (!(await verifyWebhookAuthorization(request.headers.get('authorization'), secret))) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BODY_BYTES) return { status: 413, body: { error: 'payload_too_large' } };
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_WEBHOOK_BODY_BYTES) return { status: 413, body: { error: 'payload_too_large' } };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { status: 400, body: { error: 'invalid_request' } }; }
  const event = sanitizeRevenueCatEvent(json);
  if (!event) return { status: 400, body: { error: 'invalid_request' } };
  let result: BillingApplyResult;
  try {
    result = await applyBillingEvent(env, event);
  } catch (error) {
    // The database refused the event's shape: a 400, not a retryable outage.
    if (error instanceof SupabaseRestError && JSON.stringify(error.body ?? '').includes('billing_invalid_event')) {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    throw error;
  }
  return { status: 200, body: { ok: true, outcome: result.outcome, replayed: result.replayed } };
}

export interface BillingOffering { offering: 'default' | 'founding'; founding: boolean; reservedUntil: string | null }

/** Which RevenueCat offering this user may see. The server decides Founding 100; never the app. */
export async function billingOfferingFor(env: ApiEnv, userId: string): Promise<BillingOffering> {
  if (!env.SUPABASE_SECRET_KEY) return { offering: 'default', founding: false, reservedUntil: null };
  return supabaseRest<BillingOffering>(env, SERVICE_ROLE_TOKEN, '/rest/v1/rpc/apm_service_billing_offering', {
    method: 'POST', body: JSON.stringify({ p_user_id: userId }),
  });
}

export interface BillingSweepResult { skipped?: 'no_service_credential'; expired: number }

/** Cron safety net: expire store entitlements whose EXPIRATION webhook never arrived. */
export async function runBillingSweep(env: ApiEnv): Promise<BillingSweepResult> {
  if (!env.SUPABASE_SECRET_KEY) return { skipped: 'no_service_credential', expired: 0 };
  const expired = await supabaseRest<number>(env, SERVICE_ROLE_TOKEN, '/rest/v1/rpc/apm_service_billing_expire_lapsed', { method: 'POST', body: '{}' });
  return { expired: Number(expired ?? 0) };
}

export type WebPortalResult = { url: string } | { url: null; reason: 'not_configured' | 'no_web_subscription' | 'unavailable' };

/**
 * The RevenueCat Web Billing customer portal for this user's card subscription (API v2,
 * `management_url` of their newest RevenueCat Billing subscription). The customer id is the
 * verified session's user id, never anything the request names. Never throws: a missing
 * key or a RevenueCat error answers url:null and the app points to the receipt email.
 */
export async function webCustomerPortalFor(env: ApiEnv, userId: string, fetcher: typeof fetch = fetch): Promise<WebPortalResult> {
  const key = env.REVENUECAT_API_V2_KEY;
  const project = env.REVENUECAT_PROJECT_ID;
  if (!key || !project || !/^proj[0-9a-z]+$/i.test(project)) return { url: null, reason: 'not_configured' };
  try {
    const response = await fetcher(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(project)}/customers/${encodeURIComponent(userId)}/subscriptions?limit=20`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (response.status === 404) return { url: null, reason: 'no_web_subscription' };
    if (!response.ok) return { url: null, reason: 'unavailable' };
    const body = await response.json() as { items?: Array<{ store?: string; management_url?: string | null; starts_at?: number }> };
    const web = (body.items ?? [])
      .filter((item) => (item.store === 'rc_billing' || item.store === 'stripe') && typeof item.management_url === 'string' && /^https:\/\//.test(item.management_url))
      .sort((a, b) => (b.starts_at ?? 0) - (a.starts_at ?? 0));
    return web[0]?.management_url ? { url: web[0].management_url } : { url: null, reason: 'no_web_subscription' };
  } catch {
    return { url: null, reason: 'unavailable' };
  }
}

/**
 * RevenueCat v2 `product_id` (the dashboard's internal id) -> the store identifier the webhook
 * reports as `product_id`. The v2 subscription read gives only the internal id, and the
 * Worker's read-only key cannot read product configuration, so the mapping is pinned here and
 * services/api/test/billing-worker.test.mjs proves it covers EXACTLY BILLING_PRODUCTS. A product
 * missing from this map is never guessed: reconcile skips it and the webhook remains the path.
 */
export const REVENUECAT_V2_PRODUCT_IDS: Readonly<Record<string, string>> = {
  prod5668d84428: 'apm_cos_monthly',
  prod74fe7b8e27: 'apm_cos_monthly_founding',
  prod82e18452f6: 'apm_cos_annual',
  prod6371e0bbd9: 'apm_lifeos_monthly',
  prod8fc9287e2d: 'apm_lifeos_annual',
  prod5ae1849750: 'apm_autopilot_monthly',
  prod9c0b0effca: 'apm_autopilot_annual',
  prod6df7e6a266: 'apm_cos:monthly',
  prod3d0a840964: 'apm_cos:founding-monthly',
  prodec87878554: 'apm_cos:annual',
  prodf554c0a937: 'apm_lifeos:monthly',
  prodb49f3ac243: 'apm_lifeos:annual',
  prod23b20e9949: 'apm_autopilot:monthly',
  proda63696b155: 'apm_autopilot:annual',
  prod55a7776fc5: 'apm_web_cos_monthly',
  prodd268ac7476: 'apm_web_cos_monthly_founding',
  prod5b26143a3c: 'apm_web_cos_annual',
  prodc87e7e553f: 'apm_web_lifeos_monthly',
  prod67b0cd398b: 'apm_web_lifeos_annual',
  prod707eaae618: 'apm_web_autopilot_monthly',
  prode5f37c9120: 'apm_web_autopilot_annual',
};

/** RevenueCat v2 `store` -> the webhook's `store` value (which apm_billing_apply_event maps to a channel). */
const V2_STORE_TO_WEBHOOK: Readonly<Record<string, string>> = {
  app_store: 'APP_STORE', mac_app_store: 'MAC_APP_STORE', play_store: 'PLAY_STORE', rc_billing: 'RC_BILLING', stripe: 'STRIPE',
};

/** The fields reconcile reads from a RevenueCat v2 subscription object. */
export interface RevenueCatV2Subscription {
  id?: string; customer_id?: string; product_id?: string; store?: string; environment?: string;
  status?: string; gives_access?: boolean; auto_renewal_status?: string;
  current_period_starts_at?: number | null; current_period_ends_at?: number | null;
}

/** v2 statuses under which a subscription is paid-for right now. */
const ACCESS_STATUSES = new Set(['active', 'trialing', 'in_grace_period']);

/**
 * Turns the customer's RevenueCat v2 subscriptions into webhook-shaped events for the SAME
 * database writer the webhook uses (apm_billing_apply_event): one grant (RENEWAL) for the newest
 * subscription that gives access now, plus a CANCELLATION when auto-renew is off. Event ids are
 * derived from the subscription id and its current period, so a repeated reconcile is a replay,
 * and event times are the period start, so a later real webhook event is newer and still lands.
 * A lapsed, expired, unmapped or other-customer subscription yields nothing: reconcile can only
 * ever grant what RevenueCat says is paid for now, and never takes access away (the webhook and
 * the expiry sweep do that).
 */
export function reconcileEventsFor(userId: string, subscriptions: readonly RevenueCatV2Subscription[], nowMs: number): SanitizedBillingEvent[] {
  const live = subscriptions.filter((sub) => sub.gives_access === true && ACCESS_STATUSES.has(String(sub.status))
    && sub.customer_id === userId && typeof sub.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(sub.id)
    && typeof sub.current_period_starts_at === 'number' && typeof sub.current_period_ends_at === 'number'
    && sub.current_period_ends_at > nowMs && sub.current_period_starts_at <= sub.current_period_ends_at
    && Boolean(REVENUECAT_V2_PRODUCT_IDS[String(sub.product_id)]) && Boolean(V2_STORE_TO_WEBHOOK[String(sub.store)])
    && (sub.environment === 'production' || sub.environment === 'sandbox'))
    .sort((a, b) => (b.current_period_starts_at ?? 0) - (a.current_period_starts_at ?? 0));
  const sub = live[0];
  if (!sub) return [];
  const startsAt = sub.current_period_starts_at as number;
  const base = {
    app_user_id: userId,
    product_id: REVENUECAT_V2_PRODUCT_IDS[sub.product_id as string]!,
    store: V2_STORE_TO_WEBHOOK[sub.store as string]!,
    environment: sub.environment === 'sandbox' ? 'SANDBOX' : 'PRODUCTION',
    expiration_at_ms: sub.current_period_ends_at as number,
  };
  const events: SanitizedBillingEvent[] = [{ ...base, id: `reconcile:${sub.id}:${startsAt}`, type: 'RENEWAL', event_timestamp_ms: startsAt }];
  if (sub.auto_renewal_status === 'will_not_renew') {
    events.push({ ...base, id: `reconcile-cancel:${sub.id}:${startsAt}`, type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: startsAt + 1 });
  }
  return events;
}

export type ReconcileResult =
  | { reconciled: true; outcomes: string[] }
  | { reconciled: false; reason: 'not_configured' | 'no_active_subscription' | 'unavailable' | 'rate_limited' };

/** Per-isolate fallback limiter (the RECONCILE_LIMITER binding is the real one in deployed Workers). */
const localReconcileHits = new Map<string, number[]>();
export const RECONCILE_LIMIT = { requests: 6, windowMs: 60_000 } as const;

async function reconcileAllowed(env: ApiEnv, userId: string, nowMs: number): Promise<boolean> {
  if (env.RECONCILE_LIMITER) {
    try { return (await env.RECONCILE_LIMITER.limit({ key: `billing-reconcile:${userId}` })).success; } catch { /* fall back below */ }
  }
  const recent = (localReconcileHits.get(userId) ?? []).filter((at) => at > nowMs - RECONCILE_LIMIT.windowMs);
  if (recent.length >= RECONCILE_LIMIT.requests) { localReconcileHits.set(userId, recent); return false; }
  recent.push(nowMs); localReconcileHits.set(userId, recent);
  if (localReconcileHits.size > 5000) localReconcileHits.clear();
  return true;
}

/**
 * The webhook's safety net: read the signed-in user's subscriptions from RevenueCat (API v2,
 * the read-only REVENUECAT_API_V2_KEY) and apply them through the SAME database writer and the
 * SAME sandbox rule as the webhook. Used after a card checkout (/billing/return, "I already
 * paid") so a missed or filtered webhook never leaves a paying customer without access. The
 * customer id is the verified session's user id, never anything the request names.
 */
export async function reconcileBillingFor(env: ApiEnv, userId: string, fetcher: typeof fetch = fetch, nowMs: number = Date.now()): Promise<ReconcileResult> {
  const key = env.REVENUECAT_API_V2_KEY;
  const project = env.REVENUECAT_PROJECT_ID;
  if (!key || !project || !/^proj[0-9a-z]+$/i.test(project) || !env.SUPABASE_SECRET_KEY || !UUID.test(userId)) return { reconciled: false, reason: 'not_configured' };
  if (!(await reconcileAllowed(env, userId, nowMs))) return { reconciled: false, reason: 'rate_limited' };
  let items: RevenueCatV2Subscription[];
  try {
    const response = await fetcher(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(project)}/customers/${encodeURIComponent(userId)}/subscriptions?limit=20`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (response.status === 404) return { reconciled: false, reason: 'no_active_subscription' };
    if (!response.ok) return { reconciled: false, reason: 'unavailable' };
    items = ((await response.json()) as { items?: RevenueCatV2Subscription[] }).items ?? [];
  } catch {
    return { reconciled: false, reason: 'unavailable' };
  }
  const events = reconcileEventsFor(userId, items, nowMs);
  if (events.length === 0) return { reconciled: false, reason: 'no_active_subscription' };
  const outcomes: string[] = [];
  for (const event of events) {
    outcomes.push((await applyBillingEvent(env, event)).outcome);
  }
  return { reconciled: true, outcomes };
}

// ---------------------------------------------------------------- pay first, account after
// "Join the Founding 100" (aplayermode.com and the welcome page) opens the card checkout BEFORE
// any account exists (docs/33 §10). The web app mints a random UUID, the checkout id, keeps it in
// that browser and passes it to the Web Purchase Link as the RevenueCat app user id. Afterwards
// the buyer claims it: the server creates the APM account WITH THAT SAME ID, so the RevenueCat
// app user id IS the account's user id and every existing path (webhook, reconcile, portal,
// Founding 100 slot) works unchanged, with no mapping table to drift. The webhook that arrived
// before the account existed was recorded as ignored_unknown_user; the claim reconciles it.

export type PrecheckoutClaimResult =
  | { status: 200; body: { claimed: true; outcomes: string[] } }
  | { status: 400 | 409 | 429 | 502 | 503; body: { error: string; message?: string } };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CLAIM_MESSAGES = {
  not_paid: 'We could not find a paid subscription for this checkout yet. If you just paid, wait a minute and try again.',
  email_mismatch: 'Use the same email address you entered at checkout.',
  email_has_account: 'That email already has an A Player Mode account. Email support@aplayermode.com from that address and we will move your subscription to it.',
  already_claimed: 'This payment is already attached to an account. Sign in with the email you paid with.',
} as const;

async function authAdmin(env: ApiEnv, path: string, init: RequestInit, fetcher: typeof fetch): Promise<Response> {
  const secret = env.SUPABASE_SECRET_KEY!;
  const headers = new Headers({ apikey: secret, 'content-type': 'application/json' });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  return fetcher(`${env.SUPABASE_URL}${path}`, { ...init, headers });
}

async function revenueCatGet<T>(env: ApiEnv, path: string, fetcher: typeof fetch): Promise<{ status: number; body?: T }> {
  const response = await fetcher(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID!)}${path}`, {
    headers: { authorization: `Bearer ${env.REVENUECAT_API_V2_KEY}`, accept: 'application/json' },
  });
  return { status: response.status, body: response.ok ? await response.json() as T : undefined };
}

/**
 * Claims a pay-first checkout for an account that does not exist yet. All of these must hold:
 * the checkout id is a UUID no account uses; RevenueCat says that customer has a subscription
 * paid for NOW (the same filter and sandbox rule as reconcile); the email given is the one the
 * buyer typed at checkout (RevenueCat's $email attribute). Then the account is created with
 * id = checkout id and the paid events are applied through the one billing writer. The caller
 * still has to prove the email with the usual 6-digit code before it gets a session.
 */
export async function claimPrecheckout(env: ApiEnv, input: unknown, fetcher: typeof fetch = fetch, nowMs: number = Date.now()): Promise<PrecheckoutClaimResult> {
  const checkoutId = typeof (input as { checkoutId?: unknown })?.checkoutId === 'string' ? (input as { checkoutId: string }).checkoutId.trim().toLowerCase() : '';
  const email = typeof (input as { email?: unknown })?.email === 'string' ? (input as { email: string }).email.trim().toLowerCase() : '';
  if (!UUID.test(checkoutId) || !EMAIL.test(email)) return { status: 400, body: { error: 'invalid_request' } };
  if (!env.REVENUECAT_API_V2_KEY || !env.REVENUECAT_PROJECT_ID || !/^proj[0-9a-z]+$/i.test(env.REVENUECAT_PROJECT_ID) || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) {
    return { status: 503, body: { error: 'not_configured' } };
  }
  if (!(await reconcileAllowed(env, `claim:${checkoutId}`, nowMs))) return { status: 429, body: { error: 'rate_limited' } };
  try {
    const subs = await revenueCatGet<{ items?: RevenueCatV2Subscription[] }>(env, `/customers/${encodeURIComponent(checkoutId)}/subscriptions?limit=20`, fetcher);
    if (subs.status !== 200 && subs.status !== 404) return { status: 502, body: { error: 'unavailable' } };
    const events = reconcileEventsFor(checkoutId, subs.body?.items ?? [], nowMs).filter((event) => event.environment === 'PRODUCTION' || billingSandboxAllowed(env, event));
    if (events.length === 0) return { status: 409, body: { error: 'not_paid', message: CLAIM_MESSAGES.not_paid } };
    const attrs = await revenueCatGet<{ items?: Array<{ name?: string; value?: unknown }> }>(env, `/customers/${encodeURIComponent(checkoutId)}/attributes?limit=50`, fetcher);
    if (attrs.status !== 200) return { status: 502, body: { error: 'unavailable' } };
    const paidWith = attrs.body?.items?.find((item) => item.name === '$email')?.value;
    if (typeof paidWith !== 'string' || paidWith.trim().toLowerCase() !== email) return { status: 409, body: { error: 'email_mismatch', message: CLAIM_MESSAGES.email_mismatch } };

    const existing = await authAdmin(env, `/auth/v1/admin/users/${checkoutId}`, { method: 'GET' }, fetcher);
    if (existing.ok) {
      // A retry after the account was made (the code email was lost): same id AND same email only.
      const user = await existing.json() as { email?: string };
      if ((user.email ?? '').toLowerCase() !== email) return { status: 409, body: { error: 'already_claimed', message: CLAIM_MESSAGES.already_claimed } };
    } else if (existing.status === 404) {
      const created = await authAdmin(env, '/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ id: checkoutId, email, email_confirm: true }) }, fetcher);
      if (created.status === 422) return { status: 409, body: { error: 'email_has_account', message: CLAIM_MESSAGES.email_has_account } };
      if (!created.ok) return { status: 502, body: { error: 'unavailable' } };
      const made = await created.json() as { id?: string };
      // Fail closed if the auth server ever ignored the requested id: the payment would be orphaned.
      if (made.id !== checkoutId) {
        await authAdmin(env, `/auth/v1/admin/users/${encodeURIComponent(String(made.id))}`, { method: 'DELETE' }, fetcher).catch(() => undefined);
        return { status: 502, body: { error: 'unavailable' } };
      }
    } else {
      return { status: 502, body: { error: 'unavailable' } };
    }
    const outcomes: string[] = [];
    for (const event of events) outcomes.push((await applyBillingEvent(env, event)).outcome);
    return { status: 200, body: { claimed: true, outcomes } };
  } catch {
    return { status: 502, body: { error: 'unavailable' } };
  }
}
