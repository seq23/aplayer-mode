// Plain-language API errors (docs/35 E4). A person never sees an error code, an HTTP
// status or a request id; those stay on the error object for code and support.

/** Server error codes → what the person reads. Anything unknown falls back by status. */
const CODE_COPY: Record<string, string> = {
  unauthorized: 'Your sign-in expired. Sign in again; nothing you saved is lost.',
  entitlement_required: 'Your plan does not include this yet. Pick a plan in Settings → Your plan.',
  life_os_required: 'This part needs Executive Suite or Autopilot. See Settings → Your plan.',
  plan_autonomy_ceiling: 'Your plan does not allow that much autonomy. See Settings → Your plan.',
  install_in_progress: 'Your OS is already installing. Give it a moment.',
  invalid_request: 'Something in that was not quite right. Check it and try again.',
  confirmation_required: 'Confirm first, then try again.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  service_unavailable: 'APM is busy right now. Try again in a minute.',
};

export const OFFLINE_COPY = 'You seem to be offline. Check your connection and try again.';
export const TIMEOUT_COPY = 'APM is taking too long to answer. Check your connection and try again.';

/** A server `message` is shown only when it reads like a sentence (never a snake_case code). */
function isHumanSentence(text: string | undefined): text is string {
  return Boolean(text && /\s/.test(text.trim()) && !/^[a-z0-9_.:-]+$/i.test(text.trim()));
}

export function friendlyApiMessage(status: number, body: { error?: string; message?: string } = {}): string {
  if (isHumanSentence(body.message)) return body.message.trim();
  if (body.error && CODE_COPY[body.error]) return CODE_COPY[body.error]!;
  if (status === 401) return CODE_COPY.unauthorized!;
  if (status === 403) return 'That is not available on your account right now.';
  if (status === 404) return 'That is no longer there. Pull to refresh or go back.';
  if (status === 409) return 'That already changed. Refresh and try again.';
  if (status === 429) return CODE_COPY.rate_limited!;
  if (status >= 500) return 'APM had a problem on its side. Try again in a minute.';
  return 'That did not work. Try again.';
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(status: number, body: { error?: string; message?: string } = {}, requestId?: string) {
    super(friendlyApiMessage(status, body));
    this.name = 'ApiError';
    this.status = status;
    if (body.error) this.code = body.error;
    if (requestId) this.requestId = requestId;
  }
}

/** Network failures and timeouts become plain sentences too (status 0). */
export function networkError(cause: unknown): ApiError {
  const timedOut = (cause as { name?: string } | undefined)?.name === 'AbortError';
  const error = new ApiError(0, { message: timedOut ? TIMEOUT_COPY : OFFLINE_COPY });
  return error;
}

export function errorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** The one way a screen turns any thrown value into words for a person. */
export function plainError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && isHumanSentence(error.message) && !/\(\d{3}\)|EXPO_PUBLIC|configured/i.test(error.message)) return error.message;
  return fallback;
}
