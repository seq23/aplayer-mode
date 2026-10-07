import type { ActionRecord, AutonomyLevel, Permission, SubscriptionEntitlement } from '@apm/domain';
import { decideAuthority, maxAutonomyForPlan, type ActionDomain, type Entitlement, type PermissionGrant } from '@apm/policy';
import type { ApiEnv } from './env';
import { actionDomainEnabled, actionsGloballyEnabled } from './env';
import { restErrorMessage, serviceRpc } from './db';
import { getValidConnectorToken } from './connectors/oauth';

interface ActionRow {
  id: string; domain: string; action_type: string; status: ActionRecord['status']; payload: Record<string, unknown>;
  reason: string; permission_id: string | null; idempotency_key: string; requires_approval: boolean;
  approved_at: string | null; executed_at: string | null; verified_at: string | null; failure_code: string | null;
  created_at: string; updated_at: string;
}

function mapAction(row: ActionRow, userId: string): ActionRecord {
  return {
    id: row.id, userId, domain: row.domain, actionType: row.action_type, status: row.status, payload: row.payload ?? {},
    reason: row.reason, permissionId: row.permission_id ?? undefined, idempotencyKey: row.idempotency_key,
    requiresApproval: row.requires_approval, approvedAt: row.approved_at ?? undefined, executedAt: row.executed_at ?? undefined,
    verifiedAt: row.verified_at ?? undefined, failureCode: row.failure_code ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function policyPermission(userId: string, permission: Permission | undefined): PermissionGrant | undefined {
  if (!permission) return undefined;
  return {
    userId,
    domain: permission.domain as ActionDomain,
    maxLevel: permission.autonomyLevel,
    enabled: permission.enabled,
    updatedAt: permission.updatedAt,
  };
}

function policyEntitlement(entitlement: SubscriptionEntitlement | undefined, domain: ActionDomain): Entitlement | undefined {
  if (!entitlement || !['active','trialing'].includes(entitlement.status)) return undefined;
  return { domain, maxAvailableLevel: maxAutonomyForPlan(entitlement.plan, domain), enabled: true };
}

export function authorizeAction(input: {
  env: ApiEnv;
  userId: string;
  domain: ActionDomain;
  requestedLevel: AutonomyLevel;
  permission?: Permission;
  entitlement?: SubscriptionEntitlement;
  forExecution?: boolean;
}) {
  const globalExecutionEnabled = input.forExecution ? actionsGloballyEnabled(input.env) : true;
  const domainExecutionEnabled = input.forExecution ? actionDomainEnabled(input.env, input.domain) : true;
  return decideAuthority({
    userId: input.userId,
    domain: input.domain,
    requestedLevel: input.requestedLevel,
    permission: policyPermission(input.userId, input.permission),
    entitlement: policyEntitlement(input.entitlement, input.domain),
    globalExecutionEnabled,
    domainExecutionEnabled,
  });
}

/** Maps the action ledger's refusals (0043) and policy refusals to HTTP. */
export function actionErrorResponse(error: unknown): { error: string; status: 400 | 403 | 409 | 503 } | undefined {
  const message = restErrorMessage(error) ?? (error instanceof Error ? error.message : '');
  if (message === 'action_idempotency_conflict') return { error: 'idempotency_conflict', status: 409 };
  if (message === 'action_invalid_state') return { error: 'invalid_action_state', status: 409 };
  if (message === 'action_key_reserved' || message === 'action_invalid_request') return { error: 'invalid_request', status: 400 };
  if (message === 'action_needs_user') return { error: 'needs_user', status: 409 };
  if (message.startsWith('action_not_authorized:')) return { error: 'action_not_authorized', status: 403 };
  if (message === 'service_unavailable') return { error: 'service_unavailable', status: 503 };
  return undefined;
}

export async function prepareAction(input: {
  env: ApiEnv; accessToken: string; userId: string; domain: ActionDomain; actionType: string;
  payload: Record<string, unknown>; reason: string; idempotencyKey: string; permission?: Permission; entitlement?: SubscriptionEntitlement;
}): Promise<{ action: ActionRecord; replayed: boolean }> {
  const decision = authorizeAction({ ...input, requestedLevel: 3, forExecution: false });
  if (!decision.allowed) throw new Error(`action_not_authorized:${decision.reason}`);
  // Service-role ledger write (0043): insert-or-return, never a reset of an existing row.
  // A prepared action always needs its own explicit approval, whatever the permission level;
  // level 5 is reachable only through an Autopilot standing rule (0018).
  const result = await serviceRpc<{ action: ActionRow; replayed: boolean }>(input.env, 'apm_service_action_prepare', {
    p_user_id: input.userId, p_domain: input.domain, p_action_type: input.actionType, p_payload: input.payload,
    p_reason: input.reason, p_permission_id: input.permission?.id ?? null, p_idempotency_key: input.idempotencyKey,
  });
  if (!result?.action) throw new Error('action_prepare_failed');
  return { action: mapAction(result.action, input.userId), replayed: Boolean(result.replayed) };
}

async function executeCalendar(action: ActionRecord, input: { env: ApiEnv; accessToken: string; userId: string }): Promise<string> {
  const connectionId = String(action.payload.connectionId ?? '');
  if (!connectionId) throw new Error('action_connection_required');
  const auth = await getValidConnectorToken({ ...input, connectionId });
  if (auth.kind !== 'calendar') throw new Error('action_connection_kind_mismatch');
  const title = String(action.payload.title ?? '').trim();
  const startsAt = String(action.payload.startsAt ?? '');
  const endsAt = String(action.payload.endsAt ?? '');
  if (!title || !startsAt || !endsAt) throw new Error('calendar_action_invalid');

  if (auth.provider === 'google') {
    const eventId = action.actionType === 'calendar.update' ? String(action.payload.externalEventId ?? '') : '';
    const url = eventId
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
      : 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const response = await fetch(url, {
      method: eventId ? 'PATCH' : 'POST',
      headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: title, start: { dateTime: startsAt }, end: { dateTime: endsAt }, location: action.payload.location ?? undefined }),
    });
    if (!response.ok) throw new Error(`google_calendar_action_failed:${response.status}`);
    const data = await response.json() as { id?: string };
    return data.id ?? eventId;
  }

  const eventId = action.actionType === 'calendar.update' ? String(action.payload.externalEventId ?? '') : '';
  const url = eventId ? `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}` : 'https://graph.microsoft.com/v1.0/me/events';
  const response = await fetch(url, {
    method: eventId ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: title, start: { dateTime: startsAt, timeZone: 'UTC' }, end: { dateTime: endsAt, timeZone: 'UTC' }, location: action.payload.location ? { displayName: String(action.payload.location) } : undefined }),
  });
  if (!response.ok) throw new Error(`microsoft_calendar_action_failed:${response.status}`);
  if (response.status === 204) return eventId;
  const data = await response.json() as { id?: string };
  return data.id ?? eventId;
}

function toBase64Url(value: string): string {
  return btoa(unescape(encodeURIComponent(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function executeEmail(action: ActionRecord, input: { env: ApiEnv; accessToken: string; userId: string }, sendOverride?: boolean): Promise<string> {
  const connectionId = String(action.payload.connectionId ?? '');
  if (!connectionId) throw new Error('action_connection_required');
  const to = String(action.payload.to ?? '').trim();
  const subject = String(action.payload.subject ?? '').trim();
  const body = String(action.payload.body ?? '');
  if (!to || !subject) throw new Error('email_action_invalid');
  // Raw MIME headers: CR/LF (or any control character) in To/Subject could
  // inject extra recipients. Checked before any credential is loaded; applies
  // to approved and standing email actions.
  if (/[\u0000-\u001f\u007f]/.test(to) || /[\u0000-\u001f\u007f]/.test(subject)) throw new Error('email_action_invalid');
  const auth = await getValidConnectorToken({ ...input, connectionId });
  if (auth.kind !== 'email') throw new Error('action_connection_kind_mismatch');
  const send = sendOverride ?? action.actionType === 'email.send';

  if (auth.provider === 'google') {
    const raw = toBase64Url(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`);
    const url = send ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
    const response = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(send ? { raw } : { message: { raw } }),
    });
    if (!response.ok) throw new Error(`gmail_action_failed:${response.status}`);
    const data = await response.json() as { id?: string; message?: { id?: string } };
    return data.id ?? data.message?.id ?? '';
  }

  const message = { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] };
  if (send) {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (!response.ok) throw new Error(`microsoft_send_failed:${response.status}`);
    return `sent:${action.id}`;
  }
  const response = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
    method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`microsoft_draft_failed:${response.status}`);
  const data = await response.json() as { id?: string };
  return data.id ?? '';
}

/** Executes one authorised action at its provider and returns the provider reference. */
export async function executeConnectorAction(action: ActionRecord, input: { env: ApiEnv; accessToken: string; userId: string }): Promise<string> {
  if (action.domain === 'calendar' && ['calendar.create','calendar.update'].includes(action.actionType)) return executeCalendar(action, input);
  if (action.domain === 'email' && ['email.draft','email.send'].includes(action.actionType)) return executeEmail(action, input);
  throw new Error('unsupported_action_type');
}

type ConnectorInput = { env: ApiEnv; accessToken: string; userId: string };

/** The database-composed write for a standing run (migration 0033); never client text. */
function composedOf(action: ActionRecord): Record<string, unknown> {
  const composed = action.payload.composed;
  if (!composed || typeof composed !== 'object' || Array.isArray(composed)) throw new Error('standing_action_not_composed');
  return composed as Record<string, unknown>;
}

async function moveCalendarEvent(connectionId: string, externalEventId: string, startsAt: string, endsAt: string, input: ConnectorInput): Promise<string> {
  if (!connectionId || !externalEventId || !startsAt || !endsAt) throw new Error('calendar_move_invalid');
  const auth = await getValidConnectorToken({ ...input, connectionId });
  if (auth.kind !== 'calendar') throw new Error('action_connection_kind_mismatch');
  const id = encodeURIComponent(externalEventId);
  const response = auth.provider === 'google'
    // sendUpdates=all: attendees get the provider's own update notice.
    ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=all`, {
      method: 'PATCH', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start: { dateTime: startsAt }, end: { dateTime: endsAt } }),
    })
    : await fetch(`https://graph.microsoft.com/v1.0/me/events/${id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start: { dateTime: startsAt, timeZone: 'UTC' }, end: { dateTime: endsAt, timeZone: 'UTC' } }),
    });
  if (!response.ok) throw new Error(`${auth.provider}_calendar_move_failed:${response.status}`);
  return externalEventId;
}

async function respondToInvitation(connectionId: string, externalEventId: string, response: 'declined' | 'accepted', note: string | undefined, input: ConnectorInput): Promise<string> {
  if (!connectionId || !externalEventId) throw new Error('calendar_response_invalid');
  // The note is the rule's own (user-written or the fixed polite default): it is
  // sent as the RSVP comment, never as a header.
  if (note !== undefined && (note.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(note))) throw new Error('calendar_response_invalid');
  const auth = await getValidConnectorToken({ ...input, connectionId });
  if (auth.kind !== 'calendar') throw new Error('action_connection_kind_mismatch');
  const id = encodeURIComponent(externalEventId);
  if (auth.provider === 'google') {
    const current = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`, { headers: { authorization: `Bearer ${auth.accessToken}` } });
    if (!current.ok) throw new Error(`google_calendar_read_failed:${current.status}`);
    const event = await current.json() as { attendees?: Array<Record<string, unknown> & { self?: boolean }> };
    const attendees = event.attendees ?? [];
    if (!attendees.some((attendee) => attendee.self)) throw new Error('google_calendar_not_invited');
    const next = attendees.map((attendee) => attendee.self
      ? { ...attendee, responseStatus: response, ...(note ? { comment: note } : { comment: undefined }) }
      : attendee);
    const patched = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=all`, {
      method: 'PATCH', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attendees: next }),
    });
    if (!patched.ok) throw new Error(`google_calendar_response_failed:${patched.status}`);
    return externalEventId;
  }
  const verb = response === 'declined' ? 'decline' : 'accept';
  const answered = await fetch(`https://graph.microsoft.com/v1.0/me/events/${id}/${verb}`, {
    method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sendResponse: true, ...(note ? { comment: note } : {}) }),
  });
  if (!answered.ok) throw new Error(`microsoft_calendar_response_failed:${answered.status}`);
  return externalEventId;
}

/**
 * Executes one CLAIMED standing action at its provider. Every class reads only
 * the database-composed write (`payload.composed`): event ids, recipients and
 * message text the database derived or validated, never raw client input.
 */
export async function executeStandingConnectorAction(action: ActionRecord, input: ConnectorInput): Promise<string> {
  const composed = composedOf(action);
  const connectionId = String(composed.connectionId ?? '');
  const as = (payload: Record<string, unknown>, actionType: string): ActionRecord => ({ ...action, actionType, payload: { ...payload, connectionId } });
  switch (action.actionType) {
    case 'calendar.create':
      return executeCalendar(as(composed, 'calendar.create'), input);
    case 'email.draft':
      return executeEmail(as(composed, 'email.draft'), input, false);
    case 'email.send':
    case 'appointment.book':
    case 'subscription.cancel':
      // Fixed or rule-bound text composed by the database; sent from the user's own mailbox.
      return executeEmail(as(composed, 'email.send'), input, true);
    case 'calendar.reschedule':
      return moveCalendarEvent(connectionId, String(composed.externalEventId ?? ''), String(composed.startsAt ?? ''), String(composed.endsAt ?? ''), input);
    case 'calendar.decline':
      return respondToInvitation(connectionId, String(composed.externalEventId ?? ''), 'declined', typeof composed.note === 'string' ? composed.note : undefined, input);
    default:
      throw new Error('unsupported_action_type');
  }
}

/** Reverses a reversible standing write from the ledger's undo target. */
export async function revertStandingConnectorAction(
  target: { undoMethod: 'delete_event' | 'delete_draft' | 'restore_time' | 'reaccept' | 'none'; connectionId: string; externalRef: string; originalStartsAt?: string; originalEndsAt?: string },
  input: ConnectorInput,
): Promise<void> {
  if (target.undoMethod === 'none') throw new Error('autopilot_cannot_undo');
  if (target.undoMethod === 'restore_time') {
    await moveCalendarEvent(target.connectionId, target.externalRef, target.originalStartsAt ?? '', target.originalEndsAt ?? '', input);
    return;
  }
  if (target.undoMethod === 'reaccept') {
    await respondToInvitation(target.connectionId, target.externalRef, 'accepted', undefined, input);
    return;
  }
  await revertConnectorAction({ undoMethod: target.undoMethod, connectionId: target.connectionId, externalRef: target.externalRef }, input);
}

/**
 * Reverses a reversible Autopilot write: deletes the created calendar event or
 * the prepared draft. A provider 404/410 means it is already gone.
 */
export async function revertConnectorAction(
  target: { undoMethod: 'delete_event' | 'delete_draft'; connectionId: string; externalRef: string },
  input: { env: ApiEnv; accessToken: string; userId: string },
): Promise<void> {
  if (!target.connectionId || !target.externalRef) throw new Error('undo_target_invalid');
  const auth = await getValidConnectorToken({ ...input, connectionId: target.connectionId });
  const ref = encodeURIComponent(target.externalRef);
  let url: string;
  if (target.undoMethod === 'delete_event') {
    if (auth.kind !== 'calendar') throw new Error('action_connection_kind_mismatch');
    url = auth.provider === 'google'
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${ref}`
      : `https://graph.microsoft.com/v1.0/me/events/${ref}`;
  } else {
    if (auth.kind !== 'email') throw new Error('action_connection_kind_mismatch');
    url = auth.provider === 'google'
      ? `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${ref}`
      : `https://graph.microsoft.com/v1.0/me/messages/${ref}`;
  }
  const response = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${auth.accessToken}` } });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`undo_failed:${response.status}`);
}

export async function approveAndMaybeExecuteAction(input: {
  env: ApiEnv; accessToken: string; userId: string; action: ActionRecord; permission?: Permission; entitlement?: SubscriptionEntitlement;
}): Promise<ActionRecord> {
  const domain = input.action.domain as ActionDomain;
  // An Autopilot stop (payment asked, no emailed route) is the user's to finish
  // themselves: approving it can never make APM pay, book or log in.
  if (input.action.payload && 'stoppedReason' in input.action.payload) throw new Error('action_needs_user');
  // This route is a per-action approval, so it is always level 4. A row's
  // requires_approval flag is client-writable and never escalates to level 5;
  // standing authority goes through the Autopilot claim path instead.
  const requestedLevel: AutonomyLevel = 4;
  const decision = authorizeAction({ ...input, domain, requestedLevel, forExecution: true });
  if (!decision.allowed) throw new Error(`action_not_authorized:${decision.reason}`);

  // Atomic claim: `update … where status in ('prepared','approved') returning`. A second
  // concurrent approval gets no row (action_invalid_state) and never reaches the provider.
  const claimed = mapAction(await serviceRpc<ActionRow>(input.env, 'apm_service_action_claim', { p_user_id: input.userId, p_action_id: input.action.id }), input.userId);
  const provider = String(claimed.payload.provider ?? '');
  let externalRef = '';
  try {
    externalRef = await executeConnectorAction(claimed, input);
  } catch (error) {
    const failureCode = error instanceof Error ? error.message.slice(0, 120) : 'unknown_failure';
    // The failed execution is recorded and audited too.
    await serviceRpc(input.env, 'apm_service_action_result', {
      p_user_id: input.userId, p_action_id: claimed.id, p_outcome: 'failed', p_provider: provider, p_external_ref: null, p_failure_code: failureCode,
    }).catch(() => undefined);
    throw error;
  }
  const row = await serviceRpc<ActionRow>(input.env, 'apm_service_action_result', {
    p_user_id: input.userId, p_action_id: claimed.id, p_outcome: 'verified', p_provider: provider, p_external_ref: externalRef || null, p_failure_code: null,
  });
  return mapAction(row, input.userId);
}
