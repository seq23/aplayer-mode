import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { SERVICE_ROLE_TOKEN, supabaseRest } from './db';

/**
 * The first-run intake draft and install idempotency (migration 0061). Every write goes
 * through the governed RPCs; the anonymous-draft merge and the maintenance sweep run with
 * the server-only service credential.
 */

export interface IntakeDraftView {
  bankVersion: number;
  version: number;
  answers: Record<string, unknown>;
  answeredAt: Record<string, number>;
  cursor: string;
  status: 'open' | 'installed' | 'pending_edit';
  updatedAt: number;
  installedVersion: number | null;
}

const rpc = <T>(env: ApiEnv, token: string, fn: string, args: Record<string, unknown>) =>
  supabaseRest<T>(env, token, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

export const getIntakeDraft = (env: ApiEnv, accessToken: string) => rpc<IntakeDraftView | null>(env, accessToken, 'apm_get_intake_draft', {});
export const saveIntakeDraft = (env: ApiEnv, accessToken: string, draft: Record<string, unknown>) => rpc<IntakeDraftView>(env, accessToken, 'apm_save_intake_draft', { p_draft: draft });
export const claimIntakeInstall = (env: ApiEnv, accessToken: string, key: string) => rpc<'claimed' | 'replay' | 'in_progress'>(env, accessToken, 'apm_claim_intake_install', { p_key: key });
export const finishIntakeInstall = (env: ApiEnv, accessToken: string, key: string, ok: boolean, version: number | null) =>
  rpc<void>(env, accessToken, 'apm_finish_intake_install', { p_key: key, p_ok: ok, p_version: version });

export function hasServiceCredential(env: ApiEnv): boolean {
  return Boolean(env.SUPABASE_SECRET_KEY);
}

export const mergeAnonymousDraft = (env: ApiEnv, fromUserId: string, toUserId: string) =>
  rpc<{ outcome: 'draft' | 'pending_edit' | 'nothing_to_merge' }>(env, SERVICE_ROLE_TOKEN, 'apm_service_merge_anonymous_draft', { p_from: fromUserId, p_to: toUserId });

/** Deletes an auth user through the Auth admin API (server-only secret). */
export async function deleteAuthUser(env: ApiEnv, userId: string): Promise<void> {
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('Supabase service credential is not configured');
  const { url } = requireSupabaseConfig(env);
  const headers = new Headers({ apikey: secret });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers });
  if (!response.ok && response.status !== 404) throw new Error(`auth_admin_delete_failed_${response.status}`);
}

export interface IntakeMaintenanceResult { skipped?: 'no_service_credential'; deletedDrafts: number; deletedAnonymous: number; failed: number }

/** Daily cron: installed drafts after 30 days (docs/09), anonymous users idle for 30 days. */
export async function runIntakeMaintenance(env: ApiEnv): Promise<IntakeMaintenanceResult> {
  if (!hasServiceCredential(env)) return { skipped: 'no_service_credential', deletedDrafts: 0, deletedAnonymous: 0, failed: 0 };
  const result = await rpc<{ deletedDrafts: number; staleAnonymous: string[] }>(env, SERVICE_ROLE_TOKEN, 'apm_service_intake_maintenance', {});
  let deleted = 0;
  let failed = 0;
  for (const id of result.staleAnonymous ?? []) {
    try { await deleteAuthUser(env, id); deleted += 1; } catch { failed += 1; }
  }
  return { deletedDrafts: Number(result.deletedDrafts ?? 0), deletedAnonymous: deleted, failed };
}
