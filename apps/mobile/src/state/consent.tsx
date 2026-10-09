import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CONSUMER_HEALTH_POLICY_VERSION, HEALTH_CONSENT_ANSWER_KEY } from '@apm/planning';
import { confirmAdult, fetchConsents, isApmApiConfigured, recordHealthDataDecision, type ConsentState, type HealthDataDecision } from '../api/apmApi';
import { readSync, removeSync, writeSync } from '../intake/storage';
import { useIntake } from '../intake/store';
import { useLifeGraph } from './lifeGraph';
import { useSession } from './session';

/**
 * The 18+ confirmation and the consumer health data consent (server migration 0093).
 *
 * Before an account exists the taps are kept on this device; the moment a session exists
 * they are sent to the server, which records them with its own timestamp. The server is the
 * truth: it refuses every account route until 18+ is on file, so the app shows the age
 * screen to any signed-in person the server has no confirmation for (an account made before
 * this, or one made from "I have an account").
 */
const AGE_KEY = 'apm.consent.age.v1';
const HEALTH_KEY = 'apm.consent.health.v1';

interface PendingHealth { decision: HealthDataDecision; policyVersion: string }

interface ConsentContextValue {
  /** Signed in: the server's answer. Signed out: this device's tap. */
  ageConfirmed: boolean;
  /** Signed in and the server has no 18+ confirmation (show the age screen). */
  needsAge: boolean;
  /** Signed in, 18+ on file, and no health-data decision anywhere (ask once). */
  needsHealthDecision: boolean;
  healthDecision?: HealthDataDecision;
  healthRecordedAt?: string;
  busy: boolean;
  error?: string;
  confirmAge: () => Promise<void>;
  decideHealth: (decision: HealthDataDecision) => Promise<void>;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

function readPendingHealth(): PendingHealth | undefined {
  try { const raw = readSync(HEALTH_KEY); return raw ? (JSON.parse(raw) as PendingHealth) : undefined; } catch { return undefined; }
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const { status, accessToken } = useSession();
  const { draft, answer, resync } = useIntake();
  const { refresh } = useLifeGraph();
  const [server, setServer] = useState<ConsentState | undefined>();
  const [localAge, setLocalAge] = useState<string | undefined>(() => readSync(AGE_KEY) ?? undefined);
  const [localHealth, setLocalHealth] = useState<PendingHealth | undefined>(readPendingHealth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const loadedFor = useRef<string | undefined>(undefined);
  const signedIn = status === 'signed_in' && Boolean(accessToken) && isApmApiConfigured();

  /** After 18+ lands on the server the account routes open: pull the draft and the OS again. */
  const reopenRef = useRef(() => {});
  reopenRef.current = () => { resync(); void refresh().catch(() => undefined); };
  const reopen = useCallback(() => reopenRef.current(), []);
  // A failed read (offline, server busy) is retried after a pause, never in a tight loop.
  const [retry, setRetry] = useState(0);

  // On every new session: read the server record, then send whatever this device holds that the server lacks.
  useEffect(() => {
    if (!signedIn || !accessToken) { setServer(undefined); loadedFor.current = undefined; return; }
    const key = accessToken.slice(-24);
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    let active = true;
    void (async () => {
      try {
        let state = (await fetchConsents(accessToken)).consents;
        let opened = false;
        if (!state.ageConfirmedAt && localAge) { state = (await confirmAdult(accessToken)).consents; opened = true; }
        if (!state.healthData && localHealth && state.ageConfirmedAt) state = (await recordHealthDataDecision(localHealth.decision, localHealth.policyVersion, accessToken)).consents;
        if (!active) return;
        setServer(state);
        if (opened) reopen();
      } catch {
        // Offline or busy: the server still enforces; try again in 20 s.
        if (active) setTimeout(() => { loadedFor.current = undefined; setRetry((n) => n + 1); }, 20_000);
      }
    })();
    return () => { active = false; };
  }, [accessToken, localAge, localHealth, reopen, signedIn, retry]);

  // Sign-out forgets this device's taps: the next person on this phone is asked again.
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === 'signed_in' && status === 'signed_out') {
      removeSync(AGE_KEY); removeSync(HEALTH_KEY); setLocalAge(undefined); setLocalHealth(undefined);
    }
    previous.current = status;
  }, [status]);

  const healthDecision = signedIn ? (server?.healthData?.decision ?? localHealth?.decision) : localHealth?.decision;

  // The intake reads its health questions from '_health' (packages/planning healthData.ts).
  useEffect(() => {
    if (!healthDecision) return;
    const want = healthDecision === 'granted' ? 'yes' : 'no';
    if (draft.answers[HEALTH_CONSENT_ANSWER_KEY] !== want) answer(HEALTH_CONSENT_ANSWER_KEY, want);
  }, [answer, draft.answers, healthDecision]);

  const confirmAge = useCallback(async () => {
    setError(undefined);
    const at = new Date().toISOString();
    writeSync(AGE_KEY, at); setLocalAge(at);
    if (!signedIn || !accessToken) return;
    setBusy(true);
    try { setServer((await confirmAdult(accessToken)).consents); reopen(); }
    catch { setError('That did not save. Check your connection and try again.'); throw new Error('age_not_saved'); }
    finally { setBusy(false); }
  }, [accessToken, reopen, signedIn]);

  const decideHealth = useCallback(async (decision: HealthDataDecision) => {
    setError(undefined);
    const pending = { decision, policyVersion: CONSUMER_HEALTH_POLICY_VERSION };
    if (!signedIn || !accessToken) { writeSync(HEALTH_KEY, JSON.stringify(pending)); setLocalHealth(pending); return; }
    setBusy(true);
    try {
      const state = (await recordHealthDataDecision(decision, CONSUMER_HEALTH_POLICY_VERSION, accessToken)).consents;
      writeSync(HEALTH_KEY, JSON.stringify(pending)); setLocalHealth(pending);
      setServer(state);
    } catch { setError('That did not save. Check your connection and try again.'); throw new Error('health_not_saved'); }
    finally { setBusy(false); }
  }, [accessToken, signedIn]);

  const value = useMemo<ConsentContextValue>(() => ({
    ageConfirmed: signedIn ? Boolean(server?.ageConfirmedAt) : Boolean(localAge),
    needsAge: signedIn && server !== undefined && !server.ageConfirmedAt,
    needsHealthDecision: signedIn && Boolean(server?.ageConfirmedAt) && !server?.healthData && !localHealth,
    healthDecision,
    healthRecordedAt: server?.healthData?.recordedAt,
    busy,
    error,
    confirmAge,
    decideHealth,
  }), [busy, confirmAge, decideHealth, error, healthDecision, localAge, localHealth, server, signedIn]);

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent(): ConsentContextValue {
  const value = useContext(ConsentContext);
  if (!value) throw new Error('useConsent must be used inside ConsentProvider');
  return value;
}
