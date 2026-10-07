import type {
  ActionRecord,
  AutopilotActionClass,
  AutopilotActionClassState,
  AutopilotDoneItem,
  AutopilotExecution,
  AutopilotRule,
  AutopilotRuleConstraints,
  AutopilotState,
  Permission,
  SubscriptionEntitlement,
} from '@apm/domain';
import { decideStandingAuthority, standingActionClasses, type PermissionGrant } from '@apm/policy';
import type { ApiEnv } from './env';
import { actionDomainEnabled, actionsGloballyEnabled, autopilotClassEnabled, autopilotExecutionEnabled } from './env';
import { SERVICE_ROLE_TOKEN, SupabaseRestError, supabaseRest } from './db';
import { executeStandingConnectorAction, revertStandingConnectorAction } from './actionEngine';

/**
 * Autopilot rows are written ONLY through the governed RPCs from migration
 * 0018. Direct INSERT/UPDATE/DELETE on autopilot_* tables is revoked for
 * anon/authenticated; the database checks ownership, the Autopilot entitlement,
 * the level-5 permission, class activation, the rule's constraints, idempotency
 * and the master pause, and writes the audit event in the same transaction. The
 * Worker never writes a second audit event for these transitions.
 */
async function autopilotRpc<T>(env: ApiEnv, accessToken: string, fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await supabaseRest<T>(env, accessToken, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  } catch (error) {
    const message = error instanceof SupabaseRestError
      && error.body && typeof error.body === 'object'
      && typeof (error.body as { message?: unknown }).message === 'string'
      ? (error.body as { message: string }).message
      : undefined;
    if (message && /^autopilot_[a-z_]+$/.test(message)) throw new Error(message);
    throw error;
  }
}

interface ClassRow {
  class_key: AutopilotActionClass; domain: AutopilotActionClassState['domain']; connector_kind: 'calendar' | 'email';
  action_type: string; reversible: boolean; undo_method: AutopilotActionClassState['undoMethod']; undo_label: string;
  activation_status: 'inactive' | 'active'; activated_at: string | null;
}
interface RuleRow {
  id: string; user_id: string; action_class: AutopilotActionClass; status: AutopilotRule['status'];
  constraints: AutopilotRuleConstraints; version: number; granted_at: string; expires_at: string; connection_id?: string | null;
  paused_at: string | null; revoked_at: string | null; revoke_reason: string | null; last_executed_at: string | null;
  created_at: string; updated_at: string;
}
interface ExecutionRow {
  id: string; user_id: string; rule_id: string; rule_version: number; action_class: AutopilotActionClass;
  action_id: string | null; status: AutopilotExecution['status']; idempotency_key: string; connection_id?: string | null;
  proposed_starts_at: string | null; proposed_ends_at: string | null; local_day: string;
  external_ref: string | null; failure_code: string | null; claimed_at: string; completed_at: string | null; reverted_at: string | null;
  target_ref?: string | null; original_starts_at?: string | null; original_ends_at?: string | null;
}
interface SettingsRow { user_id: string; paused: boolean; paused_at: string | null }
interface ActionRow {
  id: string; domain: string; action_type: string; status: ActionRecord['status']; payload: Record<string, unknown>;
  reason: string; permission_id: string | null; idempotency_key: string; requires_approval: boolean;
  approved_at: string | null; executed_at: string | null; verified_at: string | null; failure_code: string | null;
  created_at: string; updated_at: string;
}

const opt = <T>(value: T | null | undefined) => value ?? undefined;

export function mapClass(row: ClassRow): AutopilotActionClassState {
  return {
    actionClass: row.class_key, domain: row.domain, connectorKind: row.connector_kind, actionType: row.action_type, reversible: row.reversible,
    undoMethod: row.undo_method, undoLabel: row.undo_label, activationStatus: row.activation_status, activatedAt: opt(row.activated_at),
  };
}

export function mapRule(row: RuleRow): AutopilotRule {
  return {
    id: row.id, userId: row.user_id, actionClass: row.action_class, status: row.status, constraints: row.constraints,
    connectionId: opt(row.connection_id), version: row.version, grantedAt: row.granted_at, expiresAt: row.expires_at, pausedAt: opt(row.paused_at),
    revokedAt: opt(row.revoked_at), revokeReason: opt(row.revoke_reason), lastExecutedAt: opt(row.last_executed_at),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function mapExecution(row: ExecutionRow): AutopilotExecution {
  return {
    id: row.id, userId: row.user_id, ruleId: row.rule_id, ruleVersion: row.rule_version, actionClass: row.action_class,
    actionId: opt(row.action_id), connectionId: opt(row.connection_id), status: row.status, idempotencyKey: row.idempotency_key,
    proposedStartsAt: opt(row.proposed_starts_at), proposedEndsAt: opt(row.proposed_ends_at), localDay: row.local_day,
    externalRef: opt(row.external_ref), targetRef: opt(row.target_ref), originalStartsAt: opt(row.original_starts_at),
    originalEndsAt: opt(row.original_ends_at), failureCode: opt(row.failure_code), claimedAt: row.claimed_at,
    completedAt: opt(row.completed_at), revertedAt: opt(row.reverted_at),
  };
}

function mapActionRow(row: ActionRow, userId: string): ActionRecord {
  return {
    id: row.id, userId, domain: row.domain, actionType: row.action_type, status: row.status, payload: row.payload ?? {},
    reason: row.reason, permissionId: opt(row.permission_id), idempotencyKey: row.idempotency_key,
    requiresApproval: row.requires_approval, approvedAt: opt(row.approved_at), executedAt: opt(row.executed_at),
    verifiedAt: opt(row.verified_at), failureCode: opt(row.failure_code), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function hasAutopilotAccess(entitlement: SubscriptionEntitlement | undefined): boolean {
  return Boolean(entitlement && entitlement.plan === 'autopilot' && (entitlement.status === 'active' || entitlement.status === 'trialing'));
}

/**
 * Ordinary reads: own-row AND Autopilot entitlement (RLS). The class catalogue
 * is product metadata and always readable.
 */
export async function getAutopilotState(env: ApiEnv, accessToken: string, userId: string, entitled: boolean): Promise<AutopilotState> {
  const filter = `user_id=eq.${encodeURIComponent(userId)}`;
  const classes = await supabaseRest<ClassRow[]>(env, accessToken, '/rest/v1/autopilot_action_classes?select=*&order=class_key.asc');
  if (!entitled) return { entitled: false, masterPaused: false, classes: classes.map(mapClass), rules: [], executions: [] };
  const [rules, executions, settings] = await Promise.all([
    supabaseRest<RuleRow[]>(env, accessToken, `/rest/v1/autopilot_rules?${filter}&select=*&order=created_at.desc`),
    supabaseRest<ExecutionRow[]>(env, accessToken, `/rest/v1/autopilot_executions?${filter}&select=*&order=claimed_at.desc&limit=100`),
    supabaseRest<SettingsRow[]>(env, accessToken, `/rest/v1/autopilot_settings?${filter}&select=*&limit=1`),
  ]);
  return {
    entitled: true,
    masterPaused: Boolean(settings[0]?.paused),
    classes: classes.map(mapClass),
    rules: rules.map(mapRule),
    executions: executions.map(mapExecution),
  };
}

export async function grantAutopilotRule(env: ApiEnv, accessToken: string, input: { actionClass: AutopilotActionClass; constraints: AutopilotRuleConstraints; expiresAt: string; connectionId?: string }): Promise<AutopilotRule> {
  return mapRule(await autopilotRpc<RuleRow>(env, accessToken, 'apm_autopilot_grant_rule', {
    p_action_class: input.actionClass, p_constraints: input.constraints, p_expires_at: input.expiresAt,
    // The account the rule acts on; null = the primary account of the class's kind (0065).
    p_connection_id: input.connectionId ?? null,
  }));
}

export async function updateAutopilotRule(env: ApiEnv, accessToken: string, ruleId: string, input: { expectedVersion: number; constraints?: AutopilotRuleConstraints; expiresAt?: string }): Promise<AutopilotRule> {
  return mapRule(await autopilotRpc<RuleRow>(env, accessToken, 'apm_autopilot_update_rule', {
    p_id: ruleId, p_expected_version: input.expectedVersion, p_constraints: input.constraints ?? null, p_expires_at: input.expiresAt ?? null,
  }));
}

export async function setAutopilotRuleStatus(env: ApiEnv, accessToken: string, ruleId: string, status: 'active' | 'paused', expectedVersion: number): Promise<AutopilotRule> {
  return mapRule(await autopilotRpc<RuleRow>(env, accessToken, 'apm_autopilot_set_rule_status', {
    p_id: ruleId, p_status: status, p_expected_version: expectedVersion,
  }));
}

export async function revokeAutopilotRule(env: ApiEnv, accessToken: string, ruleId: string, reason?: string): Promise<AutopilotRule> {
  return mapRule(await autopilotRpc<RuleRow>(env, accessToken, 'apm_autopilot_revoke_rule', { p_id: ruleId, p_reason: reason ?? null }));
}

export async function setAutopilotMasterPause(env: ApiEnv, accessToken: string, paused: boolean): Promise<{ paused: boolean }> {
  const row = await autopilotRpc<SettingsRow>(env, accessToken, 'apm_autopilot_set_master_pause', { p_paused: paused });
  return { paused: Boolean(row.paused) };
}

function policyPermission(userId: string, permission: Permission | undefined): PermissionGrant | undefined {
  if (!permission) return undefined;
  return { userId, domain: permission.domain as PermissionGrant['domain'], maxLevel: permission.autonomyLevel, enabled: permission.enabled, updatedAt: permission.updatedAt };
}

/**
 * Results and undo are recorded ONLY with the server-only key (migration 0033):
 * a user can no longer mark their own claimed run failed to free their cap.
 */
const serviceRecord = <T>(env: ApiEnv, fn: string, args: Record<string, unknown>) => autopilotRpc<T>(env, SERVICE_ROLE_TOKEN, fn, args);

export type StandingRunResult =
  | { replayed: boolean; stopped?: undefined; execution: AutopilotExecution; action: ActionRecord }
  | { replayed: boolean; stopped: 'payment_required' | 'needs_user'; execution?: undefined; action: ActionRecord };

/**
 * Standing execution. Fails closed in the Worker first (kill switches incl. the
 * per-class switch, entitlement, level-5 permission, rule state, class
 * activation, master pause, the service credential that alone may record the
 * outcome), then the database claim re-checks all of it plus the class's own
 * rules and idempotency, composes the exact provider write, and creates the
 * action + execution + audit atomically — or STOPS (payment asked, no emailed
 * route) and leaves a prepared action for the user. Only a successful claim
 * reaches the provider; a replayed key never re-executes.
 */
export async function runStandingRule(input: {
  env: ApiEnv; accessToken: string; userId: string;
  rule: AutopilotRule; state: AutopilotState;
  permission?: Permission; entitlement?: SubscriptionEntitlement;
  idempotencyKey: string; reason: string; payload: Record<string, unknown>;
  now?: Date;
}): Promise<StandingRunResult> {
  const policy = standingActionClasses[input.rule.actionClass];
  const decision = decideStandingAuthority({
    userId: input.userId,
    actionClass: input.rule.actionClass,
    plan: input.entitlement?.plan,
    planUsable: hasAutopilotAccess(input.entitlement),
    permission: policyPermission(input.userId, input.permission),
    rule: { status: input.rule.status, expiresAt: input.rule.expiresAt },
    classActivated: input.state.classes.some((c) => c.actionClass === input.rule.actionClass && c.activationStatus === 'active'),
    masterPaused: input.state.masterPaused,
    globalExecutionEnabled: actionsGloballyEnabled(input.env),
    domainExecutionEnabled: actionDomainEnabled(input.env, policy.connector),
    autopilotExecutionEnabled: autopilotExecutionEnabled(input.env),
    classSwitchEnabled: autopilotClassEnabled(input.env, input.rule.actionClass),
    now: input.now ?? new Date(),
  });
  if (!decision.allowed) throw new Error(`autopilot_not_authorized:${decision.reason}`);
  if (!input.env.SUPABASE_SECRET_KEY) throw new Error('autopilot_not_authorized:service_credential_missing');

  const claim = await autopilotRpc<{ replayed: boolean; stopped?: 'payment_required' | 'needs_user'; execution?: ExecutionRow; action: ActionRow }>(input.env, input.accessToken, 'apm_autopilot_claim', {
    p_rule_id: input.rule.id, p_idempotency_key: input.idempotencyKey, p_payload: input.payload, p_reason: input.reason,
  });
  const action = mapActionRow(claim.action, input.userId);
  if (claim.stopped) return { replayed: claim.replayed, stopped: claim.stopped, action };
  if (!claim.execution) throw new Error('autopilot_invalid_execution_state');
  if (claim.replayed) return { replayed: true, execution: mapExecution(claim.execution), action };

  let externalRef: string;
  try {
    externalRef = await executeStandingConnectorAction(action, input);
    if (!externalRef) throw new Error('provider_reference_missing');
  } catch (error) {
    const failureCode = (error instanceof Error ? error.message : 'unknown_failure').replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 120) || 'unknown_failure';
    await serviceRecord(input.env, 'apm_service_autopilot_record_result', {
      p_user_id: input.userId, p_execution_id: claim.execution.id, p_outcome: 'failed', p_external_ref: null, p_failure_code: failureCode,
    });
    throw new Error('autopilot_execution_failed');
  }
  const verified = await serviceRecord<ExecutionRow>(input.env, 'apm_service_autopilot_record_result', {
    p_user_id: input.userId, p_execution_id: claim.execution.id, p_outcome: 'verified', p_external_ref: externalRef.slice(0, 500), p_failure_code: null,
  });
  return { replayed: false, execution: mapExecution(verified), action: { ...action, status: 'verified' } };
}

interface UndoTarget {
  executionId: string; actionClass: AutopilotActionClass; domain: string; connectorKind: 'calendar' | 'email';
  undoMethod: AutopilotActionClassState['undoMethod']; externalRef: string | null; connectionId: string | null;
  originalStartsAt: string | null; originalEndsAt: string | null;
}

/**
 * Undo a verified, reversible execution. The target is owner-only in the
 * database (works after downgrade) and built from the ledger, never from the
 * client; the reversal is recorded with the server-only key. Irreversible
 * classes are refused by the database with `autopilot_cannot_undo`.
 */
export async function undoStandingExecution(input: { env: ApiEnv; accessToken: string; userId: string; executionId: string }): Promise<AutopilotExecution> {
  const target = await autopilotRpc<UndoTarget>(input.env, input.accessToken, 'apm_autopilot_undo_target', { p_execution_id: input.executionId });
  if (!actionsGloballyEnabled(input.env) || !actionDomainEnabled(input.env, target.connectorKind ?? target.domain)) throw new Error('autopilot_not_authorized:global_execution_disabled');
  if (!input.env.SUPABASE_SECRET_KEY) throw new Error('autopilot_not_authorized:service_credential_missing');
  await revertStandingConnectorAction({
    undoMethod: target.undoMethod, connectionId: target.connectionId ?? '', externalRef: target.externalRef ?? '',
    originalStartsAt: target.originalStartsAt ?? undefined, originalEndsAt: target.originalEndsAt ?? undefined,
  }, input);
  return mapExecution(await serviceRecord<ExecutionRow>(input.env, 'apm_service_autopilot_record_undo', { p_user_id: input.userId, p_execution_id: input.executionId }));
}

/** The daily done-list: what Autopilot did (or stopped on) that local day, with Undo or "can't undo". Owner-only. */
export async function getAutopilotDoneList(env: ApiEnv, accessToken: string, day: string): Promise<AutopilotDoneItem[]> {
  return (await autopilotRpc<AutopilotDoneItem[] | null>(env, accessToken, 'apm_autopilot_done_list', { p_day: day })) ?? [];
}

/** Mark/unmark one of the user's events as flexible (marking needs the entitlement in the DB). */
export async function setAutopilotEventFlexible(env: ApiEnv, accessToken: string, eventId: string, flexible: boolean): Promise<{ eventId: string; flexible: boolean }> {
  return autopilotRpc(env, accessToken, 'apm_autopilot_set_event_flexible', { p_event_id: eventId, p_flexible: flexible });
}

/** Data-rights path: owner-only, no entitlement, so exports survive downgrade. */
export async function getAutopilotExportState(env: ApiEnv, accessToken: string): Promise<{ rules: AutopilotRule[]; executions: AutopilotExecution[]; masterPaused: boolean }> {
  const retained = await supabaseRest<{ autopilot_rules: RuleRow[]; autopilot_executions: ExecutionRow[]; autopilot_settings: SettingsRow | null }>(
    env, accessToken, '/rest/v1/rpc/apm_autopilot_data_rights_export', { method: 'POST', body: '{}' },
  );
  return {
    rules: (retained?.autopilot_rules ?? []).map(mapRule),
    executions: (retained?.autopilot_executions ?? []).map(mapExecution),
    masterPaused: Boolean(retained?.autopilot_settings?.paused),
  };
}

const AUTOPILOT_ERRORS: Record<string, { error: string; status: 400 | 403 | 404 | 409 | 502 }> = {
  autopilot_required: { error: 'autopilot_required', status: 403 },
  autopilot_unauthenticated: { error: 'autopilot_required', status: 403 },
  autopilot_unsupported_action_class: { error: 'unsupported_action_class', status: 400 },
  autopilot_invalid_constraints: { error: 'invalid_constraints', status: 400 },
  autopilot_invalid_expiry: { error: 'invalid_expiry', status: 400 },
  autopilot_invalid_request: { error: 'invalid_request', status: 400 },
  autopilot_invalid_payload: { error: 'invalid_request', status: 400 },
  autopilot_rule_exists: { error: 'rule_exists', status: 409 },
  autopilot_rule_not_found: { error: 'not_found', status: 404 },
  autopilot_execution_not_found: { error: 'not_found', status: 404 },
  autopilot_connection_not_found: { error: 'connection_not_found', status: 404 },
  autopilot_connection_paused: { error: 'connection_paused', status: 409 },
  autopilot_wrong_account: { error: 'wrong_account', status: 403 },
  autopilot_rule_revoked: { error: 'rule_revoked', status: 409 },
  autopilot_rule_expired: { error: 'rule_expired', status: 409 },
  autopilot_rule_inactive: { error: 'rule_inactive', status: 409 },
  autopilot_conflict: { error: 'conflict', status: 409 },
  autopilot_invalid_execution_state: { error: 'invalid_execution_state', status: 409 },
  autopilot_idempotency_conflict: { error: 'idempotency_conflict', status: 409 },
  autopilot_paused: { error: 'autopilot_paused', status: 409 },
  autopilot_class_not_activated: { error: 'class_not_activated', status: 403 },
  autopilot_permission_required: { error: 'permission_required', status: 403 },
  autopilot_outside_rule: { error: 'outside_rule', status: 403 },
  autopilot_collision: { error: 'collision', status: 409 },
  autopilot_rate_limited: { error: 'rate_limited', status: 409 },
  autopilot_connector_scope_missing: { error: 'connector_scope_missing', status: 403 },
  autopilot_event_not_found: { error: 'not_found', status: 404 },
  autopilot_event_protected: { error: 'event_protected', status: 403 },
  autopilot_payment_data_refused: { error: 'payment_data_refused', status: 403 },
  autopilot_cannot_undo: { error: 'cannot_undo', status: 409 },
  autopilot_execution_failed: { error: 'execution_failed', status: 502 },
};

export function autopilotErrorResponse(error: unknown): { error: string; status: 400 | 403 | 404 | 409 | 502; reason?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message.startsWith('autopilot_not_authorized:')) {
    return { error: 'autopilot_not_authorized', status: 403, reason: error.message.slice('autopilot_not_authorized:'.length) };
  }
  return AUTOPILOT_ERRORS[error.message];
}
