import app from './index';
import type { ApiEnv } from './env';

declare const __APM_BUILD_SHA__: string;

const BUILD_SHA = typeof __APM_BUILD_SHA__ === 'string' ? __APM_BUILD_SHA__ : 'development';

/**
 * Worker entry wrapper.
 *
 * The core Hono app remains provider-agnostic. The deployment boundary adds the
 * immutable build SHA to the public health contract so external evidence cannot
 * certify an older Worker while merely labeling it with a newer workflow SHA.
 */
export default {
  async fetch(request: Request, env: ApiEnv): Promise<Response> {
    const response = await app.fetch(request, env);
    if (new URL(request.url).pathname !== '/v1/health' || !response.ok) return response;

    const body = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=UTF-8');

    return new Response(JSON.stringify({ ...body, buildSha: BUILD_SHA }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
