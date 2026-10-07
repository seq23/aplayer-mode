import type { ApiEnv } from './env';
import { serviceRpc } from './db';

/**
 * The only audit events the Worker records itself (everything else is written
 * inside the SECURITY DEFINER function that did the work). The database holds
 * the same allow-list (private.apm_service_record_audit, migration 0043);
 * test/security-write-surface-db.test.mjs pins the two lists to each other.
 * Clients have no write access to audit_events at all.
 */
export const WORKER_AUDIT_EVENTS = {
  user: [
    'day.replan_refused', 'integration.connected', 'next_action.completed', 'notification_preferences.updated',
    'operating_mode.changed', 'permission.changed', 'personal_os.installed', 'product_interest.changed',
    'mode.entered', 'mode.exited', 'sprint.completed', 'sprint.recovery_started', 'recovery.return_declared', 'recovery.resumed',
    'auth.review_login',
  ],
  system: ['mode.auto_exited', 'mode.exited', 'sprint.completed', 'sprint.recovery_started', 'recovery.resumed', 'coaching.safety_stop'],
} as const;

export type UserAuditEvent = (typeof WORKER_AUDIT_EVENTS.user)[number];
export type SystemAuditEvent = (typeof WORKER_AUDIT_EVENTS.system)[number];

export async function recordAudit(
  env: ApiEnv,
  userId: string,
  event: { actor: 'user'; type: UserAuditEvent } | { actor: 'system'; type: SystemAuditEvent },
  metadata: Record<string, unknown> = {},
  objectType?: string,
  objectId?: string,
): Promise<void> {
  await serviceRpc<void>(env, 'apm_service_record_audit', {
    p_user_id: userId, p_event_type: event.type, p_actor_type: event.actor,
    p_object_type: objectType ?? null, p_object_id: objectId ?? null, p_metadata: metadata,
  });
}
