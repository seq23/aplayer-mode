import type {
  ActionRecord,
  CalendarEvent,
  Commitment,
  DayRecord,
  Household,
  HouseholdItem,
  HouseholdMember,
  IntegrationConnection,
  LifeAdminItem,
  LifeRelationship,
  MessageSignal,
  Milestone,
  Permission,
  Person,
  PlanActionCompletion,
  DiaryEntry,
  WeeklyReview,
  OsChangeRequest,
  Preference,
  Project,
  Routine,
  Rule,
  StoredGoalPlan,
  SubscriptionEntitlement,
} from '@apm/domain';
import type { ApiEnv } from './env';
import { serviceRpc, supabaseRest } from './db';
import { mapCompletion, mapDayRecord, mapGoalPlan, type CompletionRow, type DayRow, type GoalPlanRow } from './dailyLoopRepository';

const qs = (value: string) => encodeURIComponent(value);
interface DiaryRow { id: string; kind: DiaryEntry['kind']; body: string; local_day: string; created_at: string }
interface WeeklyReviewRow { id: string; week_start: string; summary: Record<string, unknown> | null; adjustment: string | null; completed_at: string }
interface OsChangeRow { id: string; field: OsChangeRequest['field']; proposed: unknown; previous: unknown; reason: string | null; status: OsChangeRequest['status']; created_at: string; applied_at: string | null; effective_from: string | null }

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
interface LifeRelationshipRow {
  id: string; person_id: string; birthday: string | null; next_contact_at: string | null; cadence_days: number | null; notes: string | null;
  provenance_kind: LifeRelationship['provenance']['kind']; source_type: LifeRelationship['provenance']['sourceType']; source_ref: string | null;
  confidence: number | null; created_at: string; updated_at: string;
}
interface LifeAdminItemRow {
  id: string; person_id: string | null; kind: LifeAdminItem['kind']; title: string; status: LifeAdminItem['status'];
  importance: 1 | 2 | 3 | 4 | 5; due_at: string | null; starts_at: string | null; ends_at: string | null;
  recurrence: LifeAdminItem['recurrence']; amount_minor: number | null; currency: string | null; details: Record<string, unknown>;
  completed_at: string | null; provenance_kind: LifeAdminItem['provenance']['kind']; source_type: LifeAdminItem['provenance']['sourceType'];
  source_ref: string | null; confidence: number | null; created_at: string; updated_at: string;
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
  label?: string | null; is_primary?: boolean | null; paused_at?: string | null; paused_reason?: 'plan' | null;
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

interface EntitlementRow {
  user_id: string; plan: SubscriptionEntitlement['plan']; status: SubscriptionEntitlement['status']; provider: string | null; current_period_end: string | null;
  billing_period?: 'monthly' | 'annual' | null; store_product_id?: string | null; offer?: 'standard' | 'founding' | null;
  cancel_at_period_end?: boolean | null; billing_issue_at?: string | null; pending_plan?: SubscriptionEntitlement['pendingPlan'] | null;
}
interface ProductInterestRow { interest: 'household'; status: 'interested' | 'withdrawn'; source: string; created_at: string; updated_at: string; }
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
  lifeRelationships: LifeRelationship[];
  lifeAdminItems: LifeAdminItem[];
  preferences: Preference[];
  rules: Rule[];
  connections: IntegrationConnection[];
  calendarEvents: CalendarEvent[];
  messageSignals: MessageSignal[];
  permissions: Permission[];
  actions: ActionRecord[];
  dayRecords: DayRecord[];
  goalPlans: StoredGoalPlan[];
  planCompletions: PlanActionCompletion[];
  diaryEntries: DiaryEntry[];
  weeklyReviews: WeeklyReview[];
  osChanges: OsChangeRequest[];
  entitlement?: SubscriptionEntitlement;
}

export function entitlementFromRow(userId: string, row: EntitlementRow): SubscriptionEntitlement {
  return {
    userId, plan: row.plan, status: row.status, provider: row.provider ?? undefined, currentPeriodEnd: row.current_period_end ?? undefined,
    billingPeriod: row.billing_period ?? undefined, storeProductId: row.store_product_id ?? undefined, offer: row.offer ?? undefined,
    cancelAtPeriodEnd: row.cancel_at_period_end ?? undefined, billingIssueAt: row.billing_issue_at ?? undefined, pendingPlan: row.pending_plan ?? undefined,
  };
}

export async function getPlatformState(env: ApiEnv, accessToken: string, userId: string): Promise<PlatformState> {
  const filter = `user_id=eq.${qs(userId)}`;
  const now = new Date();
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const to = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const completionsSince = new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
  const [projects, milestones, commitments, routines, people, lifeRelationships, lifeAdminItems, preferences, rules, connections, calendar, signals, permissions, actions, days, entitlements, goalPlans, completions, diary, reviews, changes] = await Promise.all([
    supabaseRest<ProjectRow[]>(env, accessToken, `/rest/v1/projects?${filter}&select=*&order=foreground.desc,updated_at.desc`),
    supabaseRest<MilestoneRow[]>(env, accessToken, `/rest/v1/milestones?${filter}&select=*&order=due_at.asc.nullslast`),
    supabaseRest<CommitmentRow[]>(env, accessToken, `/rest/v1/commitments?${filter}&select=*&order=due_at.asc.nullslast,created_at.desc`),
    supabaseRest<RoutineRow[]>(env, accessToken, `/rest/v1/routines?${filter}&select=*&order=created_at.asc`),
    supabaseRest<PersonRow[]>(env, accessToken, `/rest/v1/people?${filter}&select=*&order=name.asc`),
    supabaseRest<LifeRelationshipRow[]>(env, accessToken, `/rest/v1/life_relationships?${filter}&select=*&order=next_contact_at.asc.nullslast,created_at.desc`),
    supabaseRest<LifeAdminItemRow[]>(env, accessToken, `/rest/v1/life_admin_items?${filter}&select=*&order=due_at.asc.nullslast,created_at.desc`),
    supabaseRest<PreferenceRow[]>(env, accessToken, `/rest/v1/preferences?${filter}&select=*&order=key.asc`),
    supabaseRest<RuleRow[]>(env, accessToken, `/rest/v1/rules?${filter}&select=*&order=key.asc`),
    supabaseRest<ConnectionRow[]>(env, accessToken, `/rest/v1/integration_connections?${filter}&select=id,provider,kind,account_label,label,is_primary,paused_at,paused_reason,external_account_id,status,scopes,last_sync_at,last_error_code&order=created_at.asc`),
    supabaseRest<CalendarRow[]>(env, accessToken, `/rest/v1/calendar_events?${filter}&starts_at=gte.${qs(from)}&starts_at=lte.${qs(to)}&select=*&order=starts_at.asc`),
    supabaseRest<SignalRow[]>(env, accessToken, `/rest/v1/message_signals?${filter}&select=*&order=observed_at.desc&limit=250`),
    supabaseRest<PermissionRow[]>(env, accessToken, `/rest/v1/permissions?${filter}&select=*&order=domain.asc,action_type.asc`),
    supabaseRest<ActionRow[]>(env, accessToken, `/rest/v1/actions?${filter}&select=*&order=created_at.desc&limit=250`),
    supabaseRest<DayRow[]>(env, accessToken, `/rest/v1/day_records?${filter}&select=*&order=day.desc&limit=30`),
    supabaseRest<EntitlementRow[]>(env, accessToken, `/rest/v1/subscription_entitlements?${filter}&select=user_id,plan,status,provider,current_period_end,billing_period,store_product_id,offer,cancel_at_period_end,billing_issue_at,pending_plan&limit=1`),
    supabaseRest<GoalPlanRow[]>(env, accessToken, `/rest/v1/goal_plans?${filter}&status=neq.superseded&select=*&order=created_at.asc`),
    supabaseRest<CompletionRow[]>(env, accessToken, `/rest/v1/plan_action_completions?${filter}&day=gte.${qs(completionsSince)}&select=*&order=day.asc,created_at.asc`),
    supabaseRest<DiaryRow[]>(env, accessToken, `/rest/v1/diary_entries?${filter}&select=*&order=created_at.desc&limit=60`),
    supabaseRest<WeeklyReviewRow[]>(env, accessToken, `/rest/v1/weekly_reviews?${filter}&select=*&order=week_start.desc&limit=8`),
    supabaseRest<OsChangeRow[]>(env, accessToken, `/rest/v1/os_change_requests?${filter}&select=*&order=created_at.desc&limit=20`),
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
    lifeRelationships: lifeRelationships.map((row) => ({
      id: row.id, userId, personId: row.person_id, birthday: row.birthday ?? undefined, nextContactAt: row.next_contact_at ?? undefined,
      cadenceDays: row.cadence_days ?? undefined, notes: row.notes ?? undefined, provenance: provenance(row), createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    lifeAdminItems: lifeAdminItems.map((row) => ({
      id: row.id, userId, personId: row.person_id ?? undefined, kind: row.kind, title: row.title, status: row.status, importance: row.importance,
      dueAt: row.due_at ?? undefined, startsAt: row.starts_at ?? undefined, endsAt: row.ends_at ?? undefined, recurrence: row.recurrence ?? {},
      amountMinor: row.amount_minor ?? undefined, currency: row.currency ?? undefined, details: row.details ?? {}, completedAt: row.completed_at ?? undefined,
      provenance: provenance(row), createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    preferences: preferences.map((row) => ({ id: row.id, userId, key: row.key, value: row.value, provenance: provenance(row) })),
    rules: rules.map((row) => ({ id: row.id, userId, key: row.key, description: row.description, ruleType: row.rule_type, config: row.config, active: row.active, provenance: provenance(row) })),
    connections: connections.map((row) => ({ id: row.id, userId, provider: row.provider, kind: row.kind, accountLabel: row.account_label ?? undefined, label: row.label ?? undefined, isPrimary: row.is_primary ?? false, pausedAt: row.paused_at ?? undefined, pausedReason: row.paused_reason ?? undefined, externalAccountId: row.external_account_id ?? undefined, status: row.status, scopes: row.scopes ?? [], lastSyncAt: row.last_sync_at ?? undefined, lastErrorCode: row.last_error_code ?? undefined })),
    calendarEvents: calendar.map((row) => ({ id: row.id, userId, connectionId: row.connection_id ?? undefined, provider: row.provider, externalEventId: row.external_event_id, calendarExternalId: row.calendar_external_id ?? undefined, title: row.title, location: row.location ?? undefined, startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone ?? undefined, allDay: row.all_day, availability: row.availability, recurrence: row.recurrence ?? {}, organizer: row.organizer ?? {}, attendees: row.attendees ?? [], sourceVersion: row.source_version ?? undefined, deleted: row.deleted })),
    messageSignals: signals.map((row) => ({ id: row.id, userId, connectionId: row.connection_id ?? undefined, provider: row.provider, externalMessageId: row.external_message_id, externalThreadId: row.external_thread_id ?? undefined, signalType: row.signal_type, summary: row.summary, dueAt: row.due_at ?? undefined, confidence: row.confidence, relatedCommitmentId: row.related_commitment_id ?? undefined, userCorrectedAt: row.user_corrected_at ?? undefined, observedAt: row.observed_at })),
    permissions: permissions.map((row) => ({ id: row.id, userId, domain: row.domain, actionType: row.action_type, autonomyLevel: row.autonomy_level, constraints: row.constraints ?? {}, enabled: row.enabled, grantedAt: row.granted_at ?? undefined, updatedAt: row.updated_at })),
    actions: actions.map((row) => ({ id: row.id, userId, domain: row.domain, actionType: row.action_type, status: row.status, payload: row.payload ?? {}, reason: row.reason, permissionId: row.permission_id ?? undefined, idempotencyKey: row.idempotency_key, requiresApproval: row.requires_approval, approvedAt: row.approved_at ?? undefined, executedAt: row.executed_at ?? undefined, verifiedAt: row.verified_at ?? undefined, failureCode: row.failure_code ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at })),
    dayRecords: days.map((row) => mapDayRecord(row, userId)),
    goalPlans: goalPlans.map(mapGoalPlan) as unknown as StoredGoalPlan[],
    planCompletions: completions.map(mapCompletion),
    diaryEntries: diary.map((row) => ({ id: row.id, userId, kind: row.kind, body: row.body, localDay: row.local_day, createdAt: row.created_at })),
    weeklyReviews: reviews.map((row) => ({ id: row.id, userId, weekStart: row.week_start, summary: row.summary ?? {}, ...(row.adjustment ? { adjustment: row.adjustment } : {}), completedAt: row.completed_at })),
    osChanges: changes.map((row) => ({ id: row.id, userId, field: row.field, proposed: row.proposed, ...(row.previous != null ? { previous: row.previous } : {}), ...(row.reason ? { reason: row.reason } : {}), status: row.status, createdAt: row.created_at, ...(row.applied_at ? { appliedAt: row.applied_at } : {}), ...(row.effective_from ? { effectiveFrom: row.effective_from } : {}) })),
    entitlement: entitlements[0] ? entitlementFromRow(userId, entitlements[0]) : undefined,
  };
}

export async function getLifeOsExportState(
  env: ApiEnv,
  accessToken: string,
  userId: string,
): Promise<{ lifeRelationships: LifeRelationship[]; lifeAdminItems: LifeAdminItem[] }> {
  // Data-rights read path. Ordinary Life OS SELECT needs own-row AND an active
  // Life OS entitlement (RLS); the right to inspect/export retained data survives
  // downgrade, so it reads through the owner-only function from migration 0017
  // instead of the table policies.
  const retained = await supabaseRest<{ life_relationships: LifeRelationshipRow[]; life_admin_items: LifeAdminItemRow[] }>(
    env,
    accessToken,
    '/rest/v1/rpc/apm_life_os_data_rights_export',
    { method: 'POST', body: '{}' },
  );
  const relationshipRows = retained?.life_relationships ?? [];
  const itemRows = retained?.life_admin_items ?? [];

  const provenance = <T extends { provenance_kind: any; source_type: any; source_ref: string | null; confidence?: number | null; created_at: string }>(row: T) => ({
    kind: row.provenance_kind,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? undefined,
    confidence: row.confidence ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  });

  return {
    lifeRelationships: relationshipRows.map((row) => ({
      id: row.id,
      userId,
      personId: row.person_id,
      birthday: row.birthday ?? undefined,
      nextContactAt: row.next_contact_at ?? undefined,
      cadenceDays: row.cadence_days ?? undefined,
      notes: row.notes ?? undefined,
      provenance: provenance(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    lifeAdminItems: itemRows.map((row) => ({
      id: row.id,
      userId,
      personId: row.person_id ?? undefined,
      kind: row.kind,
      title: row.title,
      status: row.status,
      importance: row.importance,
      dueAt: row.due_at ?? undefined,
      startsAt: row.starts_at ?? undefined,
      endsAt: row.ends_at ?? undefined,
      recurrence: row.recurrence ?? {},
      amountMinor: row.amount_minor ?? undefined,
      currency: row.currency ?? undefined,
      details: row.details ?? {},
      completedAt: row.completed_at ?? undefined,
      provenance: provenance(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

/** Permissions are written only through the governed RPC (0064): own row, plan ceiling, audited. */
export async function upsertPermission(env: ApiEnv, accessToken: string, _userId: string, input: { domain: string; actionType: string; autonomyLevel: Permission['autonomyLevel']; constraints?: Record<string, unknown>; enabled?: boolean }): Promise<Permission> {
  const row = await supabaseRest<PermissionRow | null>(env, accessToken, '/rest/v1/rpc/apm_set_permission', {
    method: 'POST',
    body: JSON.stringify({ p_domain: input.domain, p_action_type: input.actionType, p_autonomy_level: input.autonomyLevel, p_constraints: input.constraints ?? {}, p_enabled: input.enabled ?? true }),
  });
  if (!row) throw new Error('permission_write_failed');
  return { id: row.id, userId: _userId, domain: row.domain, actionType: row.action_type, autonomyLevel: row.autonomy_level, constraints: row.constraints ?? {}, enabled: row.enabled, grantedAt: row.granted_at ?? undefined, updatedAt: row.updated_at };
}

export async function registerPushSubscription(env: ApiEnv, _accessToken: string, userId: string, input: { expoPushToken: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' }): Promise<void> {
  // Service role (0045): the same device token is deactivated for every other account,
  // so a shared phone never shows the previous account's notifications.
  await serviceRpc(env, 'apm_service_register_push_token', { p_user_id: userId, p_token: input.expoPushToken, p_device_id: input.deviceId ?? null, p_platform: input.platform ?? null });
}

/** Sign-out: this account stops receiving on this device. */
export async function unregisterPushSubscription(env: ApiEnv, accessToken: string, userId: string, expoPushToken: string): Promise<void> {
  await supabaseRest(env, accessToken, `/rest/v1/push_subscriptions?user_id=eq.${qs(userId)}&expo_push_token=eq.${qs(expoPushToken)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
}

export async function requestDataRightsJob(env: ApiEnv, accessToken: string, _userId: string, jobType: 'export' | 'delete'): Promise<{ id: string; status: string }> {
  // Governed and audited (0043); clients cannot write, complete or delete a job themselves.
  const row = await supabaseRest<{ id: string; status: string } | null>(env, accessToken, '/rest/v1/rpc/apm_request_data_rights', {
    method: 'POST', body: JSON.stringify({ p_job_type: jobType }),
  });
  if (!row?.id) throw new Error('data_rights_job_failed');
  return { id: row.id, status: row.status };
}

/** Every row of every user-owned table (0043 registry), secrets redacted, no row cap. */
export async function getDataRightsExport(env: ApiEnv, accessToken: string): Promise<Record<string, unknown[]>> {
  return supabaseRest<Record<string, unknown[]>>(env, accessToken, '/rest/v1/rpc/apm_data_rights_export', { method: 'POST', body: '{}' });
}

export async function completeDataExportJob(env: ApiEnv, userId: string, jobId: string): Promise<void> {
  await serviceRpc(env, 'apm_service_data_rights_complete_export', { p_user_id: userId, p_job_id: jobId });
}

export async function getAuditEvents(env: ApiEnv, accessToken: string, userId: string, limit = 100) {
  return supabaseRest<Array<{ id: string; event_type: string; actor_type: string; object_type: string | null; object_id: string | null; metadata: Record<string, unknown>; created_at: string }>>(env, accessToken, `/rest/v1/audit_events?user_id=eq.${qs(userId)}&select=id,event_type,actor_type,object_type,object_id,metadata,created_at&order=created_at.desc&limit=${Number.isInteger(limit) ? Math.min(250, Math.max(1, limit)) : 100}`);
}

export async function listModelRoutes(env: ApiEnv, accessToken: string) {
  return supabaseRest<Array<{ route_id: string; model_id: string; provider_id: string; status: string; cost_class: string; capabilities: string[]; data_classes_allowed: string[]; training_allowed: boolean; retention: string; policy_notes: string | null; last_policy_reviewed_at: string; last_eval_run_at: string | null }>>(env, accessToken, '/rest/v1/model_routes?select=route_id,model_id,provider_id,status,cost_class,capabilities,data_classes_allowed,training_allowed,retention,policy_notes,last_policy_reviewed_at,last_eval_run_at&order=cost_class.asc,route_id.asc');
}

export async function closeDay(env: ApiEnv, accessToken: string, verdict: 'full_day' | 'mvd' | 'miss', note?: string) {
  // Governed since 0021: the database closes the user's LOCAL today and audits it.
  return supabaseRest<DayRow>(env, accessToken, '/rest/v1/rpc/apm_close_day', { method: 'POST', body: JSON.stringify({ p_verdict: verdict, p_note: note ?? null }) });
}

export async function recordAnalyticsEvent(env: ApiEnv, accessToken: string, userId: string, eventName: string, properties: Record<string, unknown> = {}): Promise<void> {
  await supabaseRest(env, accessToken, '/rest/v1/analytics_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, event_name: eventName, properties }]) });
}


export async function getHouseholdInterest(env: ApiEnv, accessToken: string, userId: string): Promise<{ interested: boolean; updatedAt?: string }> {
  const rows = await supabaseRest<ProductInterestRow[]>(
    env,
    accessToken,
    `/rest/v1/product_interests?user_id=eq.${qs(userId)}&interest=eq.household&select=interest,status,source,created_at,updated_at&limit=1`,
  );
  const row = rows[0];
  return { interested: row?.status === 'interested', updatedAt: row?.updated_at };
}

export async function setHouseholdInterest(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  interested: boolean,
): Promise<{ interested: boolean; updatedAt: string }> {
  const updatedAt = new Date().toISOString();
  const rows = await supabaseRest<ProductInterestRow[]>(
    env,
    accessToken,
    '/rest/v1/product_interests?on_conflict=user_id,interest&select=interest,status,source,created_at,updated_at',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id: userId,
        interest: 'household',
        status: interested ? 'interested' : 'withdrawn',
        source: 'mobile_settings',
        updated_at: updatedAt,
      }]),
    },
  );
  const row = rows[0];
  if (!row) throw new Error('product_interest_write_failed');
  return { interested: row.status === 'interested', updatedAt: row.updated_at };
}

