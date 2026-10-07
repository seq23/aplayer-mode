import { z } from 'zod';
import type { ApiEnv } from './env';
import { SERVICE_ROLE_TOKEN, SupabaseRestError, supabaseRest } from './db';

/**
 * Phase D billing (docs/33-BILLING-PHASE-D.md). RevenueCat is the receipt verifier for
 * App Store + Google Play; its webhook is the ONLY path that changes an entitlement,
 * and only after the shared Authorization secret is verified here. The database
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

export function billingSandboxAllowed(env: ApiEnv): boolean {
  return env.BILLING_ALLOW_SANDBOX === 'true';
}

export interface BillingApplyResult { outcome: string; replayed: boolean; plan?: string; status?: string }

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
    result = await supabaseRest<BillingApplyResult>(env, SERVICE_ROLE_TOKEN, '/rest/v1/rpc/apm_service_billing_apply_event', {
      method: 'POST',
      body: JSON.stringify({ p_event: event, p_allow_sandbox: billingSandboxAllowed(env) }),
    });
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
