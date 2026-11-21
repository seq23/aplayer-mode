/**
 * Why an Autopilot run did not land, as the person reads it. The Worker records only one of
 * these codes (classifyAutopilotFailure), and every screen shows only the sentence: never a
 * provider status, an error name or a snake_case code.
 */
export const AUTOPILOT_FAILURE_SENTENCES = {
  slot_taken: 'The new time was already taken on your calendar, so nothing was moved.',
  provider_unavailable: 'Your calendar or inbox didn’t answer, so nothing was changed. Autopilot will try again later.',
  needs_reconnect: 'This account needs to be reconnected in Settings → Privacy & AI → Connections. Nothing was changed.',
  event_changed: 'The event changed after Autopilot looked at it, so it was left as you have it.',
  account_unavailable: 'The account this rule uses is paused or no longer connected, so nothing was changed.',
  refused: 'Your calendar or inbox refused the change, so nothing was changed.',
} as const;

export type AutopilotFailure = keyof typeof AUTOPILOT_FAILURE_SENTENCES;

const isFailure = (code: string): code is AutopilotFailure => Object.hasOwn(AUTOPILOT_FAILURE_SENTENCES, code);

/** Any error a standing run can throw, reduced to one closed code. */
export function classifyAutopilotFailure(error: unknown): AutopilotFailure {
  if (error instanceof TypeError) return 'provider_unavailable';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (isFailure(message)) return message;
  if (message === 'autopilot_slot_taken_live' || message === 'autopilot_undo_slot_taken') return 'slot_taken';
  if (/^(CONNECTOR_NEEDS_REAUTH|CONNECTOR_REFRESH_REVOKED|connection_needs_reauth)/.test(message)) return 'needs_reconnect';
  if (/^PROVIDER_UNAVAILABLE|_failed:(5\d\d|429)$/.test(message)) return 'provider_unavailable';
  if (/^(autopilot_undo_event_changed|calendar_move_receipt_mismatch|action_proposal_stale)$/.test(message)) return 'event_changed';
  if (/^(connection_paused|connection_credentials_missing|connection_not_found|action_connection_kind_mismatch|outlook_mail_required|action_connection_required)$/.test(message)) return 'account_unavailable';
  return 'refused';
}

/** The sentence for a recorded code, including rows written before codes were closed. */
export function autopilotFailureSentence(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return AUTOPILOT_FAILURE_SENTENCES[classifyAutopilotFailure(code)];
}
