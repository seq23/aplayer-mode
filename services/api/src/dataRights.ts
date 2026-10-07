import type { ApiEnv } from './env';
import { requireSupabaseConfig } from './env';
import { serviceRpc } from './db';
import { decryptConnectorCredential } from './crypto';

/**
 * The privileged erasure processor (right to deletion). Runs on the Cron Trigger with
 * the server-only secret key:
 *   1. claim requested delete jobs (0043, skip-locked, retried after an hour);
 *   2. revoke each connector grant at its provider (Google has a revoke endpoint;
 *      Microsoft has none for a delegated token, so its credential is destroyed);
 *   3. purge what the auth cascade would not delete (usage, analytics, billing link)
 *      and destroy every stored connector credential and push token;
 *   4. delete the auth identity (Supabase Auth admin API), which cascades every
 *      user-owned row and ends every session;
 *   5. record the erasure receipt, only once the identity is confirmed gone.
 * Any failure puts the job back to `requested` with its failure code; a request
 * still open after OVERDUE_HOURS is a NAMED STOP in the cron log.
 */
export const ERASURE_OVERDUE_HOURS = 24;

interface ClaimedErasure {
  jobId: string;
  userId: string;
  requestedAt: string;
  connections: Array<{ id: string; provider: string; kind: string; encryptedCredentials: string | null; credentialIv: string | null }>;
}

async function revokeConnector(env: ApiEnv, connection: ClaimedErasure['connections'][number]): Promise<string> {
  if (connection.provider !== 'google') return 'credential_destroyed';
  if (!connection.encryptedCredentials || !connection.credentialIv) return 'no_credential';
  const tokens = await decryptConnectorCredential<{ accessToken?: string; refreshToken?: string }>(env, connection.encryptedCredentials, connection.credentialIv);
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (!token) return 'no_credential';
  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
  });
  // 400 invalid_token: the grant is already gone.
  if (!response.ok && response.status !== 400) throw new Error(`google_revoke_failed:${response.status}`);
  return 'revoked';
}

async function deleteAuthUser(env: ApiEnv, userId: string): Promise<void> {
  const { url } = requireSupabaseConfig(env);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('service_unavailable');
  const headers = new Headers({ apikey: secret });
  if (secret.split('.').length === 3) headers.set('authorization', `Bearer ${secret}`);
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers });
  // 404: already deleted by an earlier attempt that failed before its receipt.
  if (!response.ok && response.status !== 404) throw new Error(`auth_delete_failed:${response.status}`);
}

export async function runDataRightsErasures(env: ApiEnv): Promise<{ status: 'ok' | 'not_configured'; claimed: number; erased: number; failed: number; overdue: number }> {
  if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) return { status: 'not_configured', claimed: 0, erased: 0, failed: 0, overdue: 0 };
  const claimed = (await serviceRpc<ClaimedErasure[]>(env, 'apm_service_data_rights_claim_deletions', { p_limit: 5 })) ?? [];
  let erased = 0; let failed = 0;
  for (const job of claimed) {
    try {
      const connectors: Record<string, string> = {};
      for (const connection of job.connections) connectors[connection.id] = await revokeConnector(env, connection);
      await serviceRpc(env, 'apm_service_data_rights_purge', { p_job_id: job.jobId, p_steps: { connectors, purgedAt: new Date().toISOString() } });
      await deleteAuthUser(env, job.userId);
      await serviceRpc(env, 'apm_service_data_rights_finish', { p_job_id: job.jobId, p_steps: { identityDeletedAt: new Date().toISOString() } });
      erased += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof Error ? error.message.slice(0, 200) : 'unknown_failure';
      console.error('APM data-rights erasure failed', { jobId: job.jobId, code });
      await serviceRpc(env, 'apm_service_data_rights_fail', { p_job_id: job.jobId, p_failure_code: code }).catch(() => undefined);
    }
  }
  const overdue = (await serviceRpc<number>(env, 'apm_service_data_rights_overdue', { p_hours: ERASURE_OVERDUE_HOURS })) ?? 0;
  if (overdue > 0) {
    console.error('APM NAMED STOP: data-rights erasure overdue', { overdue, hours: ERASURE_OVERDUE_HOURS, action: 'Read the failure_code on the open delete jobs; the processor retries hourly.' });
  }
  return { status: 'ok', claimed: claimed.length, erased, failed, overdue };
}
