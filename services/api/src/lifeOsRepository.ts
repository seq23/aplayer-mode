import type { LifeAdminItem, LifeAdminRecurrence, LifeRelationship, Person } from '@apm/domain';
import { nextRecurringSchedule } from '@apm/planning';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';

const qs = (value: string) => encodeURIComponent(value);

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
  resetAnchors = false,
): LifeAdminRecurrence {
  if (!recurrence.frequency) return {};
  const normalized: LifeAdminRecurrence = {
    frequency: recurrence.frequency,
    interval: recurrence.interval ?? 1,
  };
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

  const rows = await supabaseRest<RelationshipRow[]>(
    env,
    accessToken,
    '/rest/v1/life_relationships?on_conflict=user_id,person_id&select=*',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id: userId,
        person_id: person.id,
        birthday: input.birthday || null,
        next_contact_at: input.nextContactAt || null,
        cadence_days: input.cadenceDays ?? null,
        notes: input.notes ?? null,
        provenance_kind: 'stated',
        source_type: 'manual',
        confidence: 1,
        updated_at: new Date().toISOString(),
      }]),
    },
  );
  if (!rows[0]) throw new Error('life_os_relationship_write_failed');
  return { relationship: mapRelationship(rows[0], userId), personId: person.id };
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

  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.birthday !== undefined) body.birthday = input.birthday || null;
  if (input.nextContactAt !== undefined) body.next_contact_at = input.nextContactAt || null;
  if (input.cadenceDays !== undefined) body.cadence_days = input.cadenceDays || null;
  if (input.notes !== undefined) body.notes = input.notes || null;

  const rows = await supabaseRest<RelationshipRow[]>(
    env,
    accessToken,
    `/rest/v1/life_relationships?id=eq.${qs(relationshipId)}&user_id=eq.${qs(userId)}&select=*`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body),
    },
  );
  if (!rows[0]) throw new Error('life_os_relationship_not_found');
  return mapRelationship(rows[0], userId);
}

export async function createLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  input: LifeAdminInput,
): Promise<LifeAdminItem> {
  if (input.personId) await ensureOwnedPerson(env, accessToken, userId, input.personId);

  const rows = await supabaseRest<LifeAdminRow[]>(env, accessToken, '/rest/v1/life_admin_items?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      user_id: userId,
      person_id: input.personId ?? null,
      kind: input.kind,
      title: input.title,
      status: input.status ?? 'open',
      importance: input.importance ?? 3,
      due_at: input.dueAt ?? null,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      recurrence: recurrenceWithCanonicalAnchors(input.recurrence ?? {}, input.dueAt ?? null, input.startsAt ?? null, true),
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      details: input.details ?? {},
      provenance_kind: 'stated',
      source_type: 'manual',
      confidence: 1,
    }]),
  });
  if (!rows[0]) throw new Error('life_os_item_create_failed');
  return mapLifeAdminItem(rows[0], userId);
}

export async function updateLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  itemId: string,
  input: Partial<LifeAdminInput>,
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

  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
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
      true,
    );
  }
  if (input.amountMinor !== undefined) body.amount_minor = input.amountMinor;
  if (input.currency !== undefined) body.currency = input.currency || null;
  if (input.details !== undefined) body.details = input.details;

  const rows = await supabaseRest<LifeAdminRow[]>(
    env,
    accessToken,
    `/rest/v1/life_admin_items?id=eq.${qs(itemId)}&user_id=eq.${qs(userId)}&select=*`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body),
    },
  );
  if (!rows[0]) throw new Error('life_os_item_not_found');
  return mapLifeAdminItem(rows[0], userId);
}

export async function completeLifeAdminItem(
  env: ApiEnv,
  accessToken: string,
  userId: string,
  itemId: string,
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
      )
    : {};

  const hasNextOccurrence = Boolean(nextSchedule.dueAt || nextSchedule.startsAt);
  const details = { ...(existing.details ?? {}), lastCompletedAt: completedAt.toISOString() };
  const update: Record<string, unknown> = hasNextOccurrence
    ? {
        status: 'open',
        completed_at: completedAt.toISOString(),
        details,
        recurrence: effectiveRecurrence,
        updated_at: completedAt.toISOString(),
      }
    : { status: 'completed', completed_at: completedAt.toISOString(), details, updated_at: completedAt.toISOString() };

  if (nextSchedule.dueAt) update.due_at = nextSchedule.dueAt.toISOString();
  if (nextSchedule.startsAt) update.starts_at = nextSchedule.startsAt.toISOString();
  if (nextSchedule.endsAt) update.ends_at = nextSchedule.endsAt.toISOString();

  const updated = await supabaseRest<LifeAdminRow[]>(
    env,
    accessToken,
    `/rest/v1/life_admin_items?id=eq.${qs(itemId)}&user_id=eq.${qs(userId)}&select=*`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update) },
  );
  if (!updated[0]) throw new Error('life_os_item_not_found');
  return mapLifeAdminItem(updated[0], userId);
}
