import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import {
  DRAFT_STORAGE_KEY,
  calendarDateInTimezone,
  emptyDraft,
  mergeDrafts,
  parseDraft,
  patchDraft,
  setDraftAnswer,
  setDraftCursor,
  toInstallPayload,
  type AnswerValue,
  type IntakeDraft,
} from '@apm/planning';
import { fetchIntakeDraft, isApmApiConfigured, saveIntakeDraft, trackEvent } from '../api/apmApi';
import { useSession } from '../state/session';
import { useLifeGraph } from '../state/lifeGraph';
import { readSync, removeSync, writeSync } from './storage';
import { errorStatus } from '../api/errors';

/**
 * The one IntakeDraft store (docs/34 §6). Screens read answers from here and write every
 * tap here; the store writes the device copy synchronously, then the server copy (debounced
 * 500 ms, and at once when the app goes to the background). Unmounting a screen, Back,
 * killing the app or reinstalling never loses an answer.
 */
export type SyncState = 'saved' | 'saving' | 'local';

interface IntakeContextValue {
  draft: IntakeDraft;
  sync: SyncState;
  answer: (id: string, value: AnswerValue | undefined) => void;
  patch: (values: Record<string, AnswerValue>) => void;
  setCursor: (cursor: string) => void;
  /** Install from the draft: one call, idempotent by the draft version. */
  install: (displayName?: string) => Promise<'installed' | 'queued'>;
  installing: boolean;
  pendingInstall: boolean;
  /** Ids and timings only (docs/34 §6.1). */
  track: (event: string, properties?: Record<string, string | number | boolean | null>) => void;
  reset: () => void;
}

const IntakeContext = createContext<IntakeContextValue | null>(null);
const PENDING_INSTALL_KEY = 'apm.intake.pendingInstall.v1';

function loadLocal(): IntakeDraft {
  const raw = readSync(DRAFT_STORAGE_KEY);
  try { return parseDraft(raw ? JSON.parse(raw) : null, Date.now()); } catch { return emptyDraft(Date.now()); }
}

export function IntakeProvider({ children }: { children: ReactNode }) {
  const { status, accessToken } = useSession();
  const { completeMethodologyIntake } = useLifeGraph();
  const [draft, setDraft] = useState<IntakeDraft>(loadLocal);
  const [sync, setSync] = useState<SyncState>('local');
  const [installing, setInstalling] = useState(false);
  const [pendingInstall, setPendingInstall] = useState(() => readSync(PENDING_INSTALL_KEY) === '1');
  const latest = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pulledFor = useRef<string | undefined>(undefined);
  const queue = useRef<Array<{ event: string; properties: Record<string, string | number | boolean | null> }>>([]);

  const commit = useCallback((next: IntakeDraft) => {
    latest.current = next;
    writeSync(DRAFT_STORAGE_KEY, JSON.stringify(next)); // on disk before anything else happens
    setDraft(next);
  }, []);

  const pushNow = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    if (!accessToken || !isApmApiConfigured()) { setSync('local'); return; }
    const snapshot = latest.current;
    setSync('saving');
    try {
      const server = await saveIntakeDraft({ ...snapshot }, accessToken);
      // The server merged per question; fold its copy back in (a second device may have added answers).
      const merged = mergeDrafts(latest.current, parseDraft(server, Date.now()));
      if (JSON.stringify(merged.answers) !== JSON.stringify(latest.current.answers)) commit({ ...merged, cursor: latest.current.cursor });
      setSync('saved');
    } catch {
      setSync('local'); // retried on the next change, the next foreground and the next sign-in
    }
  }, [accessToken, commit]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void pushNow(); }, 500);
  }, [pushNow]);

  // On sign-in (or a token for a newly linked account): pull the server draft once, merge, push.
  useEffect(() => {
    if (status !== 'signed_in' || !accessToken || !isApmApiConfigured()) return;
    const key = accessToken.slice(-24);
    if (pulledFor.current === key) return;
    pulledFor.current = key;
    void (async () => {
      try {
        const server = await fetchIntakeDraft(accessToken);
        if (server) commit(mergeDrafts(latest.current, parseDraft(server, Date.now())));
      } catch { /* offline: the device copy stands */ }
      await pushNow();
      for (const item of queue.current.splice(0)) void trackEvent(item.event, item.properties, accessToken).catch(() => undefined);
    })();
  }, [accessToken, commit, pushNow, status]);

  // Sign-out clears the device copy; the server draft stays with the account (docs/34 §6 rule 8).
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === 'signed_in' && status === 'signed_out') {
      removeSync(DRAFT_STORAGE_KEY);
      removeSync(PENDING_INSTALL_KEY);
      commit(emptyDraft(Date.now()));
      setPendingInstall(false);
    }
    previousStatus.current = status;
  }, [commit, status]);

  // Straight to the server when the app goes to the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') void pushNow(); });
    return () => sub.remove();
  }, [pushNow]);

  const track = useCallback((event: string, properties: Record<string, string | number | boolean | null> = {}) => {
    if (accessToken && isApmApiConfigured()) void trackEvent(event, properties, accessToken).catch(() => undefined);
    else if (queue.current.length < 50) queue.current.push({ event, properties });
  }, [accessToken]);

  const install = useCallback(async (displayName?: string): Promise<'installed' | 'queued'> => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const snapshot = latest.current;
    const payload = toInstallPayload(snapshot.answers, {
      startDate: calendarDateInTimezone(new Date(), timezone),
      timezone,
      ...(displayName ? { displayName } : {}),
      draftVersion: snapshot.version,
    });
    setInstalling(true);
    try {
      await pushNow();
      await completeMethodologyIntake(payload);
      commit({ ...latest.current, installedVersion: snapshot.version });
      removeSync(PENDING_INSTALL_KEY);
      setPendingInstall(false);
      return 'installed';
    } catch (error) {
      // A refusal (4xx other than "already installing") is shown, never queued as "offline":
      // queuing it would promise "we'll finish when you're online" forever (docs/35 E13).
      const status = errorStatus(error);
      if (status !== undefined && status >= 400 && status < 500 && status !== 409) throw error;
      // Offline or the API is down: the draft is safe; install retries with the same key.
      writeSync(PENDING_INSTALL_KEY, '1');
      setPendingInstall(true);
      return 'queued';
    } finally {
      setInstalling(false);
    }
  }, [commit, completeMethodologyIntake, pushNow]);

  // A queued install retries when a session is back.
  useEffect(() => {
    if (pendingInstall && status === 'signed_in' && accessToken && !installing) void install().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, pendingInstall, status]);

  const value = useMemo<IntakeContextValue>(() => ({
    draft,
    sync,
    installing,
    pendingInstall,
    answer: (id, answerValue) => { commit(setDraftAnswer(latest.current, id, answerValue, Date.now())); schedule(); },
    patch: (values) => { commit(patchDraft(latest.current, values, Date.now())); schedule(); },
    setCursor: (cursor) => { commit(setDraftCursor(latest.current, cursor, Date.now())); schedule(); },
    install,
    track,
    reset: () => { removeSync(DRAFT_STORAGE_KEY); commit(emptyDraft(Date.now())); },
  }), [commit, draft, install, installing, pendingInstall, schedule, sync, track]);

  return <IntakeContext.Provider value={value}>{children}</IntakeContext.Provider>;
}

export function useIntake(): IntakeContextValue {
  const value = useContext(IntakeContext);
  if (!value) throw new Error('useIntake must be used inside IntakeProvider');
  return value;
}
