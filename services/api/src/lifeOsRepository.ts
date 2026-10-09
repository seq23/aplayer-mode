import type { LifeAdminItem, LifeAdminRecurrence, LifeRelationship, Person } from '@apm/domain';
import { nextRecurringSchedule } from '@apm/planning';
import type { ApiEnv } from './env';
import { SupabaseRestError, supabaseRest } from './db';

const qs = (value: string) => encodeURIComponent(value);

/**
 * Life OS rows are written ONLY through the governed RPCs from migration 0017.
 * Direct INSERT/UPDATE/DELETE on life_relationships / life_admin_items is revoked
 * for anon/authenticated, so the database enforces ownership, entitlement,
 * lifecycle rules and the audit event even if a client skips this Worker.
 */
async function lifeOsRpc<T>(env: ApiEnv, accessToken: string, fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await supabaseRest<T>(env, accessToken, `/rest/v1/rpc/${fn}`, {
      method: 'POST',
      body: JSON.stringify(args),
    });
  } catch (error) {
    const message = error instanceof SupabaseRestError
      && error.body && typeof error.body === 'object'
      && typeof (error.body as { message?: unknown }).message === 'string'
      ? (error.body as { message: string }).message
      : undefined;
    if (message && (/^life_os_[a-z_]+$/.test(message) || message === 'health_data_consent_required')) throw new Error(message);
    throw error;
  }
}

interface PersonRow {
  id: string;
  name: string;
  relationship: string | null;
  email: string | null;
  phone: string | null;
  provenance_kind: Person['provenance']['kind'];
  source_type: Person['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
}

interface RelationshipRow {
  id: string;
  person_id: string;
  birthday: string | null;
  next_contact_at: string | null;
  cadence_days: number | null;
  notes: string | null;
  provenance_kind: LifeRelationship['provenance']['kind'];
  source_type: LifeRelationship['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

interface LifeAdminRow {
  id: string;
  person_id: string | null;
  kind: LifeAdminItem['kind'];
  title: string;
  status: LifeAdminItem['status'];
  importance: 1 | 2 | 3 | 4 | 5;
  due_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  recurrence: LifeAdminRecurrence;
  amount_minor: number | null;
  currency: string | null;
  details: Record<string, unknown>;
  completed_at: string | null;
  provenance_kind: LifeAdminItem['provenance']['kind'];
  source_type: LifeAdminItem['provenance']['sourceType'];
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface RelationshipInput {
  personId?: string;
  personName?: string;
  relationship?: string;
  email?: string;
  phone?: string;
  birthday?: string;
  nextContactAt?: string;
  cadenceDays?: number | null;
  notes?: string;
}

export interface LifeAdminInput {
  personId?: string;
  kind: LifeAdminItem['kind'];
  title: string;
  status?: LifeAdminItem['status'];
  importance?: 1 | 2 | 3 | 4 | 5;
  dueAt?: string;
  startsAt?: string;
  endsAt?: string;
  recurrence?: LifeAdminRecurrence;
  amountMinor?: number | null;
  currency?: string | null;
  details?: Record<string, unknown>;
}

function recurrenceWithCanonicalAnchors(
  recurrence: LifeAdminRecurrence,
  dueAt?: string | null,
  startsAt?: string | null,
  timezone?: string,
  resetAnchors = false,
): LifeAdminRecurrence {
  if (!recurrence.frequency) return {};
  const normalized: LifeAdminRecurrence = {
    frequency: recurrence.frequency,
    interval: recurrence.interval ?? 1,
  };
  const canonicalTimezone = resetAnchors
    ? timezone ?? recurrence.timezone
    : recurrence.timezone ?? timezone;
  if (canonicalTimezone) normalized.timezone = canonicalTimezone;
  const dueAnchor = resetAnchors ? dueAt ?? undefined : recurrence.anchorDueAt ?? dueAt ?? undefined;
  const startAnchor = resetAnchors ? startsAt ?? undefined : recurrence.anchorStartsAt ?? startsAt ?? undefined;
  if (dueAnchor) normalized.anchorDueAt = dueAnchor;
  if (startAnchor) normalized.anchorStartsAt = startAnchor;
  return normalized;
}

function mapRelationship(row: RelationshipRow, userId: string): LifeRelationship {
  return {
    id: row.id,
    userId,
    personId: row.person_id,
    birthday: row.birthday ?? undefined,
    nextContactAt: row.next_contact_at ?? undefined,
    cadenceDays: row.cadence_days ?? undefined,
    notes: row.notes ?? undefined,
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: row.created_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLifeAdminItem(row: LifeAdminRow, userId: string): LifeAdminItem {
  return {
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
    provenance: {
      kind: row.provenance_kind,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      confidence: row.confidence ?? undefined,
      createdAt: row.created_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureOwnedPerson(env: ApiEnv, accessToken: string, userId: string, personId: string): Promise<PersonRow> {
  const rows = await supabaseRest<PersonRow[]>(
    env,
    accessToken,
    `/rest/v1/people?id=eq.${qs(personId)}&user_id=eq.${qs(userId)}&select=*&limit=1`,
  );
  if (!rows[0]) throw new Error('life_os_person_not_found');
  return rows[0];
}

async function createPerson(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: Pick<RelationshipInput, 'personName' | 'relationship' | 'email' | 'phone'>,
): Promise<PersonRow> {
  const personName = input.personName?.trim();
  if (!personName) throw new Error('life_os_person_name_required');
  const rows = await supabaseRest<PersonRow[]>(env, accessToken, '/rest/v1/people?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      user_id: userId,
      name: personName,
      relationship: input.relationship ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      provenance_kind: 'stated',
      source_type: 'manual',
      confidence: 1,
    }]),
  });
  if (!rows[0]) throw new Error('life_os_person_create_failed');
  return rows[0];
}

async function patchPerson(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  personId: string,
  input: Pick<RelationshipInput, 'personName' | 'relationship' | 'email' | 'phone'>,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.personName !== undefined) body.name = input.personName;
  if (input.relationship !== undefined) body.relationship = input.relationship || null;
  if (input.email !== undefined) body.email = input.email || null;
  if (input.phone !== undefined) body.phone = input.phone || null;
  if (!Object.keys(body).length) return;
  body.updated_at = new Date().toISOString();
  await supabaseRest(env, accessToken, `/rest/v1/people?id=eq.${qs(personId)}&user_id=eq.${qs(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

export async function createRelationship(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: RelationshipInput,
): Promise<{ relationship: LifeRelationship; personId: string }> {
  const person = input.personId
    ? await ensureOwnedPerson(env, accessToken, userId, input.personId)
    : await createPerson(env, accessToken, userId, input);

  if (input.personId) await patchPerson(env, accessToken, userId, person.id, input);

  const row = await lifeOsRpc<RelationshipRow>(env, accessToken, 'apm_life_os_save_relationship', {
    p_person_id: person.id,
    p_birthday: input.birthday || null,
    p_next_contact_at: input.nextContactAt || null,
    p_cadence_days: input.cadenceDays ?? null,
    p_notes: input.notes ?? null,
  });
  if (!row) throw new Error('life_os_relationship_write_failed');
  return { relationship: mapRelationship(row, userId), personId: person.id };
}

export async function updateRelationship(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  relationshipId: string,
  input: Partial<RelationshipInput>,
): Promise<LifeRelationship> {
  const existing = await supabaseRest<RelationshipRow[]>(
    env,
    accessToken,
    `/rest/v1/life_relationships?id=eq.${qs(relationshipId)}&user_id=eq.${qs(userId)}&select=*&limit=1`,
  );
  const row = existing[0];
  if (!row) throw new Error('life_os_relationship_not_found');

  await patchPerson(env, accessToken, userId, row.person_id, input);

  const patch: Record<string, unknown> = {};
  if (input.birthday !== undefined) patch.birthday = input.birthday || null;
  if (input.nextContactAt !== undefined) patch.next_contact_at = input.nextContactAt || null;
  if (input.cadenceDays !== undefined) patch.cadence_days = input.cadenceDays || null;
  if (input.notes !== undefined) patch.notes = input.notes || null;

  const updated = await lifeOsRpc<RelationshipRow>(env, accessToken, 'apm_life_os_update_relationship', {
    p_id: relationshipId,
    p_patch: patch,
  });
  if (!updated) throw new Error('life_os_relationship_not_found');
  return mapRelationship(updated, userId);
}

export async function createLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: LifeAdminInput,
  timezone?: string,
): Promise<LifeAdminItem> {
  if (input.personId) await ensureOwnedPerson(env, accessToken, userId, input.personId);
  if (input.status === 'completed') throw new Error('life_os_use_completion_route');

  const row = await lifeOsRpc<LifeAdminRow>(env, accessToken, 'apm_life_os_create_item', {
    p_item: {
      person_id: input.personId ?? null,
      kind: input.kind,
      title: input.title,
      status: input.status ?? 'open',
      importance: input.importance ?? 3,
      due_at: input.dueAt ?? null,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      recurrence: recurrenceWithCanonicalAnchors(input.recurrence ?? {}, input.dueAt ?? null, input.startsAt ?? null, timezone, true),
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      details: input.details ?? {},
    },
  });
  if (!row) throw new Error('life_os_item_create_failed');
  return mapLifeAdminItem(row, userId);
}

export async function updateLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  itemId: string,
  input: Partial<LifeAdminInput>,
  timezone?: string,
): Promise<LifeAdminItem> {
  const existingRows = await supabaseRest<LifeAdminRow[]>(
    env,
    accessToken,
    `/rest/v1/life_admin_items?id=eq.${qs(itemId)}&user_id=eq.${qs(userId)}&select=*&limit=1`,
  );
  const existing = existingRows[0];
  if (!existing) throw new Error('life_os_item_not_found');

  if (input.personId) await ensureOwnedPerson(env, accessToken, userId, input.personId);
  if (input.status === 'completed') throw new Error('life_os_use_completion_route');

  const mergedDueAt = input.dueAt !== undefined ? input.dueAt || null : existing.due_at;
  const mergedStartsAt = input.startsAt !== undefined ? input.startsAt || null : existing.starts_at;
  const mergedEndsAt = input.endsAt !== undefined ? input.endsAt || null : existing.ends_at;
  if (mergedStartsAt && mergedEndsAt && Date.parse(mergedEndsAt) < Date.parse(mergedStartsAt)) {
    throw new Error('life_os_invalid_schedule');
  }

  const body: Record<string, unknown> = {};
  if (input.personId !== undefined) body.person_id = input.personId || null;
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.title !== undefined) body.title = input.title;
  if (input.status !== undefined) body.status = input.status;
  if (input.importance !== undefined) body.importance = input.importance;
  if (input.dueAt !== undefined) body.due_at = input.dueAt || null;
  if (input.startsAt !== undefined) body.starts_at = input.startsAt || null;
  if (input.endsAt !== undefined) body.ends_at = input.endsAt || null;
  if (input.recurrence !== undefined || input.dueAt !== undefined || input.startsAt !== undefined) {
    body.recurrence = recurrenceWithCanonicalAnchors(
      input.recurrence ?? existing.recurrence,
      mergedDueAt,
      mergedStartsAt,
      timezone,
      true,
    );
  }
  if (input.amountMinor !== undefined) body.amount_minor = input.amountMinor;
  if (input.currency !== undefined) body.currency = input.currency || null;
  if (input.details !== undefined) body.details = input.details;

  const row = await lifeOsRpc<LifeAdminRow>(env, accessToken, 'apm_life_os_update_item', {
    p_id: itemId,
    p_patch: body,
  });
  if (!row) throw new Error('life_os_item_not_found');
  return mapLifeAdminItem(row, userId);
}

export async function completeLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  itemId: string,
  timezone?: string,
): Promise<LifeAdminItem> {
  const rows = await supabaseRest<LifeAdminRow[]>(
    env,
    accessToken,
    `/rest/v1/life_admin_items?id=eq.${qs(itemId)}&user_id=eq.${qs(userId)}&select=*&limit=1`,
  );
  const existing = rows[0];
  if (!existing) throw new Error('life_os_item_not_found');
  if (existing.status === 'cancelled') throw new Error('life_os_item_cancelled');

  const completedAt = new Date();
  const parseDate = (value: string | null): Date | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  const effectiveRecurrence = existing.recurrence?.frequency
    ? recurrenceWithCanonicalAnchors(
        existing.recurrence,
        existing.due_at ?? (!existing.starts_at ? completedAt.toISOString() : null),
        existing.starts_at,
        timezone,
      )
    : {};

  const nextSchedule = effectiveRecurrence.frequency
    ? nextRecurringSchedule(
        {
          dueAt: parseDate(existing.due_at),
          startsAt: parseDate(existing.starts_at),
          endsAt: parseDate(existing.ends_at),
        },
        completedAt,
        effectiveRecurrence,
        timezone,
      )
    : {};

  // The deterministic planning engine computes the next occurrence; the governed
  // RPC verifies it moves forward, sets completed_at from the database clock,
  // rejects stale reads (expected updated_at) and writes the audit event.
  const row = await lifeOsRpc<LifeAdminRow>(env, accessToken, 'apm_life_os_complete_item', {
    p_id: itemId,
    p_expected_updated_at: existing.updated_at,
    p_next_due_at: nextSchedule.dueAt?.toISOString() ?? null,
    p_next_starts_at: nextSchedule.startsAt?.toISOString() ?? null,
    p_next_ends_at: nextSchedule.endsAt?.toISOString() ?? null,
    p_recurrence: effectiveRecurrence.frequency ? effectiveRecurrence : null,
  });
  if (!row) throw new Error('life_os_item_not_found');
  return mapLifeAdminItem(row, userId);
}

// Error messages raised by the governed Life OS RPCs (migration 0017) and the
// repository. Writes are audited inside the same database transaction, so the
// routes below do not write a second audit event.
const LIFE_OS_ERRORS: Record<string, { error: string; status: 400 | 403 | 404 | 409 }> = {
  life_os_required: { error: 'life_os_required', status: 403 },
  life_os_unauthenticated: { error: 'life_os_required', status: 403 },
  life_os_person_not_found: { error: 'person_not_found', status: 404 },
  life_os_relationship_not_found: { error: 'not_found', status: 404 },
  life_os_item_not_found: { error: 'not_found', status: 404 },
  life_os_item_cancelled: { error: 'invalid_item_state', status: 409 },
  life_os_conflict: { error: 'conflict', status: 409 },
  life_os_use_completion_route: { error: 'use_completion_route', status: 400 },
  life_os_invalid_schedule: { error: 'invalid_request', status: 400 },
  life_os_invalid_recurrence: { error: 'invalid_request', status: 400 },
  life_os_invalid_completion: { error: 'invalid_request', status: 400 },
  life_os_invalid_request: { error: 'invalid_request', status: 400 },
  life_os_field_not_allowed: { error: 'invalid_request', status: 400 },
  // A health-routine reminder without the consumer health data consent (migration 0093).
  health_data_consent_required: { error: 'health_data_consent_required', status: 403 },
};

export function lifeOsErrorResponse(error: unknown): { error: string; status: 400 | 403 | 404 | 409 } | undefined {
  return error instanceof Error ? LIFE_OS_ERRORS[error.message] : undefined;
}
