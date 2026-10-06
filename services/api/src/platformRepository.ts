import type {
  ActionRecord,
  CalendarEvent,
  Commitment,
  DayRecord,
  Household,
  HouseholdItem,
  HouseholdMember,
  IntegrationConnection,
  MessageSignal,
  Milestone,
  Permission,
  Person,
  Preference,
  Project,
  Routine,
  Rule,
  SubscriptionEntitlement,
} from '@apm/domain';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';

const qs = (value: string) => encodeURIComponent(value);

interface ProjectRow {
  id: string; goal_id: string | null; title: string; objective: string | null;
  status: Project['status']; foreground: boolean; review_gate_days: 30 | 60 | 90 | null; review_gate_at: string | null;
}
interface MilestoneRow {
  id: string; goal_id: string; project_id: string | null; title: string; status: Milestone['status']; due_at: string | null;
}
interface CommitmentRow {
  id: string; project_id: string | null; goal_id: string | null; person_id: string | null; title: string;
  owner: Commitment['owner']; status: Commitment['status']; due_at: string | null;
  provenance_kind: Commitment['provenance']['kind']; source_type: Commitment['provenance']['sourceType']; source_ref: string | null;
  confidence: number; user_corrected_at: string | null; created_at: string;
}
interface RoutineRow {
  id: string; title: string; pillar: Routine['pillar'] | null; target_frequency_per_week: number | null;
  preferred_window: Record<string, unknown>; active: boolean; minimum_version: string | null;
  provenance_kind: Routine['provenance']['kind']; source_type: Routine['provenance']['sourceType']; source_ref: string | null;
  confidence: number | null; created_at: string;
}
interface PersonRow {
  id: string; name: string; relationship: string | null; email: string | null; phone: string | null;
  provenance_kind: Person['provenance']['kind']; source_type: Person['provenance']['sourceType']; source_ref: string | null;
  confidence: number | null; created_at: string;
}
interface PreferenceRow {
  id: string; key: string; value: unknown; provenance_kind: Preference['provenance']['kind'];
  source_type: Preference['provenance']['sourceType']; source_ref: string | null; confidence: number | null; created_at: string;
}
interface RuleRow {
  id: string; key: string; description: string; rule_type: Rule['ruleType']; config: Record<string, unknown>; active: boolean;
  provenance_kind: Rule['provenance']['kind']; source_type: Rule['provenance']['sourceType']; source_ref: string | null; created_at: string;
}
interface ConnectionRow {
  id: string; provider: IntegrationConnection['provider']; kind: IntegrationConnection['kind']; account_label: string | null;
  external_account_id: string | null; status: IntegrationConnection['status']; scopes: string[]; last_sync_at: string | null; last_error_code: string | null;
}
interface CalendarRow {
  id: string; connection_id: string | null; provider: string; external_event_id: string; calendar_external_id: string | null;
  title: string; location: string | null; starts_at: string; ends_at: string; timezone: string | null; all_day: boolean;
  availability: CalendarEvent['availability']; recurrence: Record<string, unknown>; organizer: Record<string, unknown>; attendees: unknown[];
  source_version: string | null; deleted: boolean;
}
interface SignalRow {
  id: string; connection_id: string | null; provider: 'google' | 'microsoft'; external_message_id: string; external_thread_id: string | null;
  signal_type: MessageSignal['signalType']; summary: string; due_at: string | null; confidence: number; related_commitment_id: string | null;
  user_corrected_at: string | null; observed_at: string;
}
interface PermissionRow {
  id: string; domain: string; action_type: string; autonomy_level: Permission['autonomyLevel']; constraints: Record<string, unknown>;
  enabled: boolean; granted_at: string | null; updated_at: string;
}
interface ActionRow {
  id: string; domain: string; action_type: string; status: ActionRecord['status']; payload: Record<string, unknown>; reason: string;
  permission_id: string | null; idempotency_key: string; requires_approval: boolean; approved_at: string | null;
  executed_at: string | null; verified_at: string | null; failure_code: string | null; created_at: string; updated_at: string;
}
interface DayRow {
  id: string; day: string; mode: DayRecord['mode']; verdict: DayRecord['verdict'] | null; completed_action_ids: string[]; note: string | null; closed_at: string | null;
}
interface EntitlementRow {
  user_id: string; plan: SubscriptionEntitlement['plan']; status: SubscriptionEntitlement['status']; provider: string | null; current_period_end: string | null;
}
interface HouseholdRow { id: string; created_by: string; name: string; created_at: string; }
interface HouseholdMemberRow { household_id: string; user_id: string; role: HouseholdMember['role']; status: HouseholdMember['status']; joined_at: string; }
interface HouseholdItemRow {
  id: string; household_id: string; created_by: string; item_type: HouseholdItem['itemType']; title: string;
  details: Record<string, unknown>; assigned_user_id: string | null; status: HouseholdItem['status']; due_at: string | null;
}

export interface PlatformState {
  projects: Project[];
  milestones: Milestone[];
  commitments: Commitment[];
  routines: Routine[];
  people: Person[];
  preferences: Preference[];
  rules: Rule[];
  connections: IntegrationConnection[];
  calendarEvents: CalendarEvent[];
  messageSignals: MessageSignal[];
  permissions: Permission[];
  actions: ActionRecord[];
  dayRecords: DayRecord[];
  entitlement?: SubscriptionEntitlement;
}

export async function getPlatformState(env: ApiEnv, accessToken: string, userId: string): Promise<PlatformState> {
  const filter = `user_id=eq.${qs(userId)}`;
  const now = new Date();
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const to = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const [projects, milestones, commitments, routines, people, preferences, rules, connections, calendar, signals, permissions, actions, days, entitlements] = await Promise.all([
    supabaseRest<ProjectRow[]>(env, accessToken, `/rest/v1/projects?${filter}&select=*&order=foreground.desc,updated_at.desc`),
    supabaseRest<MilestoneRow[]>(env, accessToken, `/rest/v1/milestones?${filter}&select=*&order=due_at.asc.nullslast`),
    supabaseRest<CommitmentRow[]>(env, accessToken, `/rest/v1/commitments?${filter}&select=*&order=due_at.asc.nullslast,created_at.desc`),
    supabaseRest<RoutineRow[]>(env, accessToken, `/rest/v1/routines?${filter}&select=*&order=created_at.asc`),
    supabaseRest<PersonRow[]>(env, accessToken, `/rest/v1/people?${filter}&select=*&order=name.asc`),
    supabaseRest<PreferenceRow[]>(env, accessToken, `/rest/v1/preferences?${filter}&select=*&order=key.asc`),
    supabaseRest<RuleRow[]>(env, accessToken, `/rest/v1/rules?${filter}&select=*&order=key.asc`),
    supabaseRest<ConnectionRow[]>(env, accessToken, `/rest/v1/integration_connections?${filter}&select=id,provider,kind,account_label,external_account_id,status,scopes,last_sync_at,last_error_code&order=created_at.asc`),
    supabaseRest<CalendarRow[]>(env, accessToken, `/rest/v1/calendar_events?${filter}&starts_at=gte.${qs(from)}&starts_at=lte.${qs(to)}&select=*&order=starts_at.asc`),
    supabaseRest<SignalRow[]>(env, accessToken, `/rest/v1/message_signals?${filter}&select=*&order=observed_at.desc&limit=250`),
    supabaseRest<PermissionRow[]>(env, accessToken, `/rest/v1/permissions?${filter}&select=*&order=domain.asc,action_type.asc`),
    supabaseRest<ActionRow[]>(env, accessToken, `/rest/v1/actions?${filter}&select=*&order=created_at.desc&limit=250`),
    supabaseRest<DayRow[]>(env, accessToken, `/rest/v1/day_records?${filter}&select=*&order=day.desc&limit=30`),
    supabaseRest<EntitlementRow[]>(env, accessToken, `/rest/v1/subscription_entitlements?${filter}&select=user_id,plan,status,provider,current_period_end&limit=1`),
  ]);

  const provenance = <T extends { provenance_kind: any; source_type: any; source_ref: string | null; confidence?: number | null; created_at: string }>(row: T) => ({
    kind: row.provenance_kind,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? undefined,
    confidence: row.confidence ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  });

  return {
    projects: projects.map((row) => ({ id: row.id, userId, goalId: row.goal_id ?? undefined, title: row.title, objective: row.objective ?? undefined, status: row.status, foreground: row.foreground, reviewGateDays: row.review_gate_days ?? undefined, reviewGateAt: row.review_gate_at ?? undefined })),
    milestones: milestones.map((row) => ({ id: row.id, userId, goalId: row.goal_id, projectId: row.project_id ?? undefined, title: row.title, status: row.status, dueAt: row.due_at ?? undefined })),
    commitments: commitments.map((row) => ({ id: row.id, userId, projectId: row.project_id ?? undefined, goalId: row.goal_id ?? undefined, personId: row.person_id ?? undefined, title: row.title, owner: row.owner, status: row.status, dueAt: row.due_at ?? undefined, provenance: { ...provenance(row), userCorrectedAt: row.user_corrected_at ?? undefined } })),
    routines: routines.map((row) => ({ id: row.id, userId, title: row.title, pillar: row.pillar ?? undefined, targetFrequencyPerWeek: row.target_frequency_per_week ?? undefined, preferredWindow: row.preferred_window, active: row.active, minimumVersion: row.minimum_version ?? undefined, provenance: provenance(row) })),
    people: people.map((row) => ({ id: row.id, userId, name: row.name, relationship: row.relationship ?? undefined, email: row.email ?? undefined, phone: row.phone ?? undefined, provenance: provenance(row) })),
    preferences: preferences.map((row) => ({ id: row.id, userId, key: row.key, value: row.value, provenance: provenance(row) })),
    rules: rules.map((row) => ({ id: row.id, userId, key: row.key, description: row.description, ruleType: row.rule_type, config: row.config, active: row.active, provenance: provenance(row) })),
    connections: connections.map((row) => ({ id: row.id, userId, provider: row.provider, kind: row.kind, accountLabel: row.account_label ?? undefined, externalAccountId: row.external_account_id ?? undefined, status: row.status, scopes: row.scopes ?? [], lastSyncAt: row.last_sync_at ?? undefined, lastErrorCode: row.last_error_code ?? undefined })),
    calendarEvents: calendar.map((row) => ({ id: row.id, userId, connectionId: row.connection_id ?? undefined, provider: row.provider, externalEventId: row.external_event_id, calendarExternalId: row.calendar_external_id ?? undefined, title: row.title, location: row.location ?? undefined, startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone ?? undefined, allDay: row.all_day, availability: row.availability, recurrence: row.recurrence ?? {}, organizer: row.organizer ?? {}, attendees: row.attendees ?? [], sourceVersion: row.source_version ?? undefined, deleted: row.deleted })),
    messageSignals: signals.map((row) => ({ id: row.id, userId, connectionId: row.connection_id ?? undefined, provider: row.provider, externalMessageId: row.external_message_id, externalThreadId: row.external_thread_id ?? undefined, signalType: row.signal_type, summary: row.summary, dueAt: row.due_at ?? undefined, confidence: row.confidence, relatedCommitmentId: row.related_commitment_id ?? undefined, userCorrectedAt: row.user_corrected_at ?? undefined, observedAt: row.observed_at })),
    permissions: permissions.map((row) => ({ id: row.id, userId, domain: row.domain, actionType: row.action_type, autonomyLevel: row.autonomy_level, constraints: row.constraints ?? {}, enabled: row.enabled, grantedAt: row.granted_at ?? undefined, updatedAt: row.updated_at })),
    actions: actions.map((row) => ({ id: row.id, userId, domain: row.domain, actionType: row.action_type, status: row.status, payload: row.payload ?? {}, reason: row.reason, permissionId: row.permission_id ?? undefined, idempotencyKey: row.idempotency_key, requiresApproval: row.requires_approval, approvedAt: row.approved_at ?? undefined, executedAt: row.executed_at ?? undefined, verifiedAt: row.verified_at ?? undefined, failureCode: row.failure_code ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at })),
    dayRecords: days.map((row) => ({ id: row.id, userId, day: row.day, mode: row.mode, verdict: row.verdict ?? undefined, completedActionIds: row.completed_action_ids ?? [], note: row.note ?? undefined, closedAt: row.closed_at ?? undefined })),
    entitlement: entitlements[0] ? { userId, plan: entitlements[0].plan, status: entitlements[0].status, provider: entitlements[0].provider ?? undefined, currentPeriodEnd: entitlements[0].current_period_end ?? undefined } : undefined,
  };
}

export async function upsertPermission(env: ApiEnv, accessToken: string, userId: string, input: { domain: string; actionType: string; autonomyLevel: Permission['autonomyLevel']; constraints?: Record<string, unknown>; enabled?: boolean }): Promise<Permission> {
  const rows = await supabaseRest<PermissionRow[]>(env, accessToken, '/rest/v1/permissions?on_conflict=user_id,domain,action_type&select=*', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ user_id: userId, domain: input.domain, action_type: input.actionType, autonomy_level: input.autonomyLevel, constraints: input.constraints ?? {}, enabled: input.enabled ?? true, granted_at: input.autonomyLevel > 0 ? new Date().toISOString() : null, updated_at: new Date().toISOString() }]),
  });
  const row = rows[0];
  if (!row) throw new Error('permission_write_failed');
  return { id: row.id, userId, domain: row.domain, actionType: row.action_type, autonomyLevel: row.autonomy_level, constraints: row.constraints ?? {}, enabled: row.enabled, grantedAt: row.granted_at ?? undefined, updatedAt: row.updated_at };
}

export async function registerPushSubscription(env: ApiEnv, accessToken: string, userId: string, input: { expoPushToken: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' }): Promise<void> {
  await supabaseRest(env, accessToken, '/rest/v1/push_subscriptions?on_conflict=user_id,expo_push_token', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: userId, expo_push_token: input.expoPushToken, device_id: input.deviceId ?? null, platform: input.platform ?? null, active: true, updated_at: new Date().toISOString() }]),
  });
}

export async function requestDataRightsJob(env: ApiEnv, accessToken: string, userId: string, jobType: 'export' | 'delete'): Promise<{ id: string; status: string }> {
  const rows = await supabaseRest<Array<{ id: string; status: string }>>(env, accessToken, '/rest/v1/data_rights_jobs?select=id,status', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ user_id: userId, job_type: jobType }]),
  });
  if (!rows[0]) throw new Error('data_rights_job_failed');
  return rows[0];
}

export async function getAuditEvents(env: ApiEnv, accessToken: string, userId: string, limit = 100) {
  return supabaseRest<Array<{ id: string; event_type: string; actor_type: string; object_type: string | null; object_id: string | null; metadata: Record<string, unknown>; created_at: string }>>(env, accessToken, `/rest/v1/audit_events?user_id=eq.${qs(userId)}&select=id,event_type,actor_type,object_type,object_id,metadata,created_at&order=created_at.desc&limit=${Math.min(250, Math.max(1, limit))}`);
}

export async function listModelRoutes(env: ApiEnv, accessToken: string) {
  return supabaseRest<Array<{ route_id: string; model_id: string; provider_id: string; status: string; cost_class: string; capabilities: string[]; data_classes_allowed: string[]; training_allowed: boolean; retention: string; policy_notes: string | null; last_policy_reviewed_at: string; last_eval_run_at: string | null }>>(env, accessToken, '/rest/v1/model_routes?select=route_id,model_id,provider_id,status,cost_class,capabilities,data_classes_allowed,training_allowed,retention,policy_notes,last_policy_reviewed_at,last_eval_run_at&order=cost_class.asc,route_id.asc');
}

export async function closeDay(env: ApiEnv, accessToken: string, verdict: 'full_day' | 'mvd' | 'miss', note?: string) {
  return supabaseRest<DayRow>(env, accessToken, '/rest/v1/rpc/apm_close_day', { method: 'POST', body: JSON.stringify({ p_verdict: verdict, p_note: note ?? null }) });
}

export async function recordAnalyticsEvent(env: ApiEnv, accessToken: string, userId: string, eventName: string, properties: Record<string, unknown> = {}): Promise<void> {
  await supabaseRest(env, accessToken, '/rest/v1/analytics_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, event_name: eventName, properties }]) });
}

export async function listHouseholds(env: ApiEnv, accessToken: string): Promise<{ households: Household[]; members: HouseholdMember[]; items: HouseholdItem[] }> {
  const [households, members, items] = await Promise.all([
    supabaseRest<HouseholdRow[]>(env, accessToken, '/rest/v1/households?select=*&order=created_at.asc'),
    supabaseRest<HouseholdMemberRow[]>(env, accessToken, '/rest/v1/household_members?select=*&order=joined_at.asc'),
    supabaseRest<HouseholdItemRow[]>(env, accessToken, '/rest/v1/household_items?select=*&order=created_at.desc'),
  ]);
  return {
    households: households.map((row) => ({ id: row.id, createdBy: row.created_by, name: row.name, createdAt: row.created_at })),
    members: members.map((row) => ({ householdId: row.household_id, userId: row.user_id, role: row.role, status: row.status, joinedAt: row.joined_at })),
    items: items.map((row) => ({ id: row.id, householdId: row.household_id, createdBy: row.created_by, itemType: row.item_type, title: row.title, details: row.details ?? {}, assignedUserId: row.assigned_user_id ?? undefined, status: row.status, dueAt: row.due_at ?? undefined })),
  };
}
