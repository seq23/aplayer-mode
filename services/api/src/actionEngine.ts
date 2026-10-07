import type { ActionRecord, AutonomyLevel, Permission, SubscriptionEntitlement } from '@apm/domain';
import { decideAuthority, maxAutonomyForPlan, type ActionDomain, type Entitlement, type PermissionGrant } from '@apm/policy';
import type { ApiEnv } from './env';
import { actionDomainEnabled, actionsGloballyEnabled } from './env';
import { supabaseRest } from './db';
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

export async function prepareAction(input: {
  env: ApiEnv; accessToken: string; userId: string; domain: ActionDomain; actionType: string;
  payload: Record<string, unknown>; reason: string; idempotencyKey: string; permission?: Permission; entitlement?: SubscriptionEntitlement;
}): Promise<ActionRecord> {
  const decision = authorizeAction({ ...input, requestedLevel: 3, forExecution: false });
  if (!decision.allowed) throw new Error(`action_not_authorized:${decision.reason}`);
  const rows = await supabaseRest<ActionRow[]>(input.env, input.accessToken, '/rest/v1/actions?on_conflict=user_id,idempotency_key&select=*', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      user_id: input.userId, domain: input.domain, action_type: input.actionType, status: 'prepared', payload: input.payload,
      reason: input.reason, permission_id: input.permission?.id ?? null, idempotency_key: input.idempotencyKey,
      // Level 5 is reachable only through an Autopilot standing rule (migration
      // 0018 / autopilotRepository). A prepared action always needs its own
      // explicit approval, whatever the permission level.
      requires_approval: true, updated_at: new Date().toISOString(),
    }]),
  });
  if (!rows[0]) throw new Error('action_prepare_failed');
  return mapAction(rows[0], input.userId);
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

async function executeEmail(action: ActionRecord, input: { env: ApiEnv; accessToken: string; userId: string }): Promise<string> {
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
  const send = action.actionType === 'email.send';

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
  // This route is a per-action approval, so it is always level 4. A row's
  // requires_approval flag is client-writable and never escalates to level 5;
  // standing authority goes through the Autopilot claim path instead.
  const requestedLevel: AutonomyLevel = 4;
  const decision = authorizeAction({ ...input, domain, requestedLevel, forExecution: true });
  if (!decision.allowed) throw new Error(`action_not_authorized:${decision.reason}`);

  const now = new Date().toISOString();
  await supabaseRest(input.env, input.accessToken, `/rest/v1/actions?id=eq.${encodeURIComponent(input.action.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'executing', approved_at: now, updated_at: now }),
  });

  let externalRef = '';
  try {
    externalRef = await executeConnectorAction(input.action, input);
    await supabaseRest(input.env, input.accessToken, `/rest/v1/actions?id=eq.${encodeURIComponent(input.action.id)}&select=*`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'verified', executed_at: now, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    await supabaseRest(input.env, input.accessToken, '/rest/v1/action_attempts', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: input.userId, action_id: input.action.id, attempt: 1, status: 'succeeded', provider: String(input.action.payload.provider ?? ''), external_ref: externalRef || null, completed_at: new Date().toISOString() }]),
    });
  } catch (error) {
    const failureCode = error instanceof Error ? error.message.slice(0, 120) : 'unknown_failure';
    await supabaseRest(input.env, input.accessToken, `/rest/v1/actions?id=eq.${encodeURIComponent(input.action.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', failure_code: failureCode, updated_at: new Date().toISOString() }),
    });
    await supabaseRest(input.env, input.accessToken, '/rest/v1/action_attempts', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: input.userId, action_id: input.action.id, attempt: 1, status: 'failed', error_code: failureCode, completed_at: new Date().toISOString() }]),
    }).catch(() => undefined);
    throw error;
  }

  const rows = await supabaseRest<ActionRow[]>(input.env, input.accessToken, `/rest/v1/actions?id=eq.${encodeURIComponent(input.action.id)}&select=*&limit=1`);
  if (!rows[0]) throw new Error('action_disappeared');
  return mapAction(rows[0], input.userId);
}
