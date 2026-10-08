import app from './index';
import type { ApiEnv } from './env';
import { runMorningTrigger } from './morningTrigger';
import { runBillingSweep } from './billing';
import { runDataRightsErasures } from './dataRights';
import { runIntakeMaintenance } from './intakeRepository';

declare const __APM_BUILD_SHA__: string;
declare const __APM_RUNTIME_ENVIRONMENT__: string;

const BUILD_SHA = typeof __APM_BUILD_SHA__ === 'string' ? __APM_BUILD_SHA__ : 'development';
const RUNTIME_ENVIRONMENT =
  typeof __APM_RUNTIME_ENVIRONMENT__ === 'string' ? __APM_RUNTIME_ENVIRONMENT__ : 'development';

/**
 * Worker entry wrapper.
 *
 * The core Hono app remains provider-agnostic. The deployment boundary adds
 * immutable build and environment identity to the public health contract so
 * external evidence cannot certify an older Worker or the wrong Worker target.
 */
export default {
  /** Cloudflare Cron Trigger (wrangler.jsonc `triggers.crons`): the BHPC Morning Trigger. */
  async scheduled(controller: { scheduledTime: number; cron: string }, env: ApiEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(
      runMorningTrigger(env, new Date(controller.scheduledTime)).then(
        (result) => console.log('APM morning trigger', { cron: controller.cron, ...result }),
        (error: unknown) => console.error('APM morning trigger failed', { cron: controller.cron, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
    // Billing safety net (docs/33): expire store entitlements whose EXPIRATION webhook never came.
    ctx.waitUntil(
      runBillingSweep(env).then(
        (result) => console.log('APM billing sweep', { cron: controller.cron, ...result }),
        (error: unknown) => console.error('APM billing sweep failed', { cron: controller.cron, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
    // Right to deletion: the privileged erasure processor (dataRights.ts, migration 0043).
    ctx.waitUntil(
      runDataRightsErasures(env).then(
        (result) => console.log('APM data-rights erasures', { cron: controller.cron, ...result }),
        (error: unknown) => console.error('APM data-rights erasures failed', { cron: controller.cron, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
    // First-run intake (docs/34 §5.1, docs/09), idempotent on every tick: installed drafts after 30 days; idle anonymous users.
    ctx.waitUntil(
      runIntakeMaintenance(env).then(
        (result) => console.log('APM intake maintenance', { cron: controller.cron, ...result }),
        (error: unknown) => console.error('APM intake maintenance failed', { cron: controller.cron, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
  },

  async fetch(request: Request, env: ApiEnv): Promise<Response> {
    // HEAD is GET without a body (RFC 9110 §9.3.2). Answer it from the GET
    // response so every route, /v1/health included, gives the same status and
    // headers. Hono strips the body for HEAD, and the health wrapper below
    // would then parse an empty body and throw: HEAD /v1/health returned 500.
    if (request.method === 'HEAD') {
      const get = await handleGet(new Request(request, { method: 'GET' }), env);
      await get.body?.cancel();
      return new Response(null, { status: get.status, statusText: get.statusText, headers: get.headers });
    }
    return handleGet(request, env);
  },
};

async function handleGet(request: Request, env: ApiEnv): Promise<Response> {
    const response = await app.fetch(request, env);
    if (new URL(request.url).pathname !== '/v1/health' || !response.ok) return response;

    const body = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=UTF-8');

    return new Response(
      JSON.stringify({ ...body, buildSha: BUILD_SHA, runtimeEnvironment: RUNTIME_ENVIRONMENT }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
}
