import type { OperatingModeKey } from '@apm/domain';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';
import type { ModeState, ResumableMode } from './coach/modes';

interface ModeStateRow {
  active_mode: OperatingModeKey;
  mode_started_at: string | null;
  mode_ends_at: string | null;
  mode_focus: string | null;
  recovery_locked_until: string | null;
  mode_resume: ResumableMode | null;
}

export async function getModeState(env: ApiEnv, accessToken: string, userId: string): Promise<ModeState> {
  const rows = await supabaseRest<ModeStateRow[]>(
    env,
    accessToken,
    `/rest/v1/personal_os?user_id=eq.${encodeURIComponent(userId)}&select=active_mode,mode_started_at,mode_ends_at,mode_focus,recovery_locked_until,mode_resume&limit=1`,
  );
  const row = rows[0];
  if (!row) return { mode: 'standard' };
  return {
    mode: row.active_mode,
    startedAt: row.mode_started_at ?? undefined,
    endsAt: row.mode_ends_at ?? undefined,
    focus: row.mode_focus ?? undefined,
    recoveryLockedUntil: row.recovery_locked_until ?? undefined,
    resume: row.mode_resume ?? undefined,
  };
}

/** Persists a state already validated by `transitionMode`/`reconcileModeState`; the RPC re-checks the invariants (migration 0020). */
export async function saveModeState(env: ApiEnv, accessToken: string, state: ModeState): Promise<void> {
  await supabaseRest<void>(env, accessToken, '/rest/v1/rpc/apm_set_mode_state', {
    method: 'POST',
    body: JSON.stringify({
      p_mode: state.mode,
      p_started_at: state.startedAt ?? null,
      p_ends_at: state.endsAt ?? null,
      p_focus: state.focus ?? null,
      p_recovery_locked_until: state.recoveryLockedUntil ?? null,
      p_resume: state.resume ?? null,
    }),
  });
}
