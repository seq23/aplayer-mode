import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DailyPlan, LifeGraphSnapshot } from '@apm/domain';
import {
  completeLifeOsItem,
  createLifeOsItem,
  createLifeRelationship,
  fetchTodayState,
  isApmApiConfigured,
  persistActionCompletion,
  installIntake,
  persistOperatingMode,
  updateLifeOsItem,
  updateLifeRelationship,
  type ApiIntakeInstallInput,
  type LifeAdminInput,
  type LifeRelationshipInput,
  type ModeChangeRequest,
  type ModeStateView,
  type TodayLoopView,
  type TodayState,
} from '../api/apmApi';
import { useSession } from './session';

function emptyGraph(userId = 'unassigned'): LifeGraphSnapshot {
  return {
    identity: { userId, displayName: '' },
    roles: [],
    pillarSettings: [],
    tracks: [],
    modes: [],
    personalOS: undefined,
    goals: [],
    milestones: [],
    projects: [],
    commitments: [],
    nextActions: [],
    routines: [],
    people: [],
    lifeRelationships: [],
    lifeAdminItems: [],
    preferences: [],
    rules: [],
    radarItems: [],
    evidence: [],
    connections: [],
    calendarEvents: [],
    messageSignals: [],
    permissions: [],
    actions: [],
    dayRecords: [],
    goalPlans: [],
    planCompletions: [],
    diaryEntries: [],
    weeklyReviews: [],
    osChanges: [],
    entitlement: undefined,
  };
}


type SyncStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

interface LifeGraphContextValue {
  graph: LifeGraphSnapshot;
  todayPlan?: DailyPlan;
  modeState?: ModeStateView;
  todayLoop?: TodayLoopView;
  syncStatus: SyncStatus;
  syncError?: string;
  isDurable: boolean;
  refresh: () => Promise<void>;
  /** The one install call of the first-run intake (idempotent by its key). */
  completeMethodologyIntake: (input: ApiIntakeInstallInput) => Promise<void>;
  setOperatingMode: (request: ModeChangeRequest) => Promise<void>;
  applyTodayState: (state: TodayState) => void;
  /** Runs one authenticated API call that returns the rebuilt Today and applies it. */
  perform: <T extends TodayState>(call: (token: string) => Promise<T>) => Promise<T>;
  completeNextAction: (actionId: string) => Promise<void>;
  createRelationship: (input: LifeRelationshipInput) => Promise<void>;
  updateRelationship: (relationshipId: string, input: Partial<LifeRelationshipInput>) => Promise<void>;
  createLifeItem: (input: LifeAdminInput) => Promise<void>;
  updateLifeItem: (itemId: string, input: Partial<LifeAdminInput>) => Promise<void>;
  completeLifeItem: (itemId: string) => Promise<void>;
}

const LifeGraphContext = createContext<LifeGraphContextValue | null>(null);

export function LifeGraphProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, user, accessToken } = useSession();
  const [graph, setGraph] = useState<LifeGraphSnapshot>(() => emptyGraph());
  const [todayPlan, setTodayPlan] = useState<DailyPlan>();
  const [modeState, setModeState] = useState<ModeStateView>();
  const [todayLoop, setTodayLoop] = useState<TodayLoopView>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string>();

  const isDurable = Boolean(sessionStatus === 'signed_in' && user && accessToken && isApmApiConfigured());

  const requireDurableSession = (): { userId: string; token: string } => {
    if (sessionStatus !== 'signed_in' || !user || !accessToken) throw new Error('Sign in before changing your APM');
    if (!isApmApiConfigured()) throw new Error('The APM API is not configured for this build');
    return { userId: user.id, token: accessToken };
  };

  const applyServerState = (state: TodayState) => {
    setGraph(state.graph);
    setTodayPlan(state.plan);
    setModeState(state.mode);
    setTodayLoop(state.today);
    setSyncStatus('ready');
  };

  const refresh = async () => {
    if (sessionStatus !== 'signed_in' || !user || !accessToken) {
      setGraph(emptyGraph()); setTodayPlan(undefined); setSyncStatus('ready'); return;
    }
    if (!isApmApiConfigured()) {
      setSyncStatus('error'); setSyncError('The APM API is not configured for this build.'); return;
    }
    setSyncStatus('loading'); setSyncError(undefined);
    try { applyServerState(await fetchTodayState(accessToken)); }
    catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to load your APM'); throw error; }
  };

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    if (sessionStatus !== 'signed_in' || !user || !accessToken) {
      setGraph(emptyGraph()); setTodayPlan(undefined); setSyncStatus('ready'); setSyncError(undefined); return;
    }
    if (!isApmApiConfigured()) {
      setGraph(emptyGraph(user.id)); setTodayPlan(undefined); setSyncStatus('error'); setSyncError('The APM API is not configured for this build.'); return;
    }
    let active = true;
    setSyncStatus('loading'); setSyncError(undefined);
    void fetchTodayState(accessToken)
      .then((state) => { if (!active) return; setGraph(state.graph); setTodayPlan(state.plan); setModeState(state.mode); setTodayLoop(state.today); setSyncStatus('ready'); })
      .catch((error: unknown) => { if (!active) return; setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to load your APM'); });
    return () => { active = false; };
  }, [accessToken, sessionStatus, user]);

  const value = useMemo<LifeGraphContextValue>(() => ({
    graph, todayPlan, modeState, todayLoop, syncStatus, syncError, isDurable, refresh,
    applyTodayState: (state) => applyServerState(state),
    perform: async (call) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { const state = await call(token); applyServerState(state); return state; }
      catch (error) { setSyncStatus('ready'); throw error; }
    },
    completeMethodologyIntake: async (input) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await installIntake(input, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to install your Personal OS'); throw error; }
    },
    setOperatingMode: async (modeRequest) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await persistOperatingMode(modeRequest, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to change APM mode'); throw error; }
    },
    completeNextAction: async (actionId) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await persistActionCompletion(actionId, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to record completion'); throw error; }
    },
    createRelationship: async (input) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await createLifeRelationship(input, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to save relationship'); throw error; }
    },
    updateRelationship: async (relationshipId, input) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await updateLifeRelationship(relationshipId, input, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to update relationship'); throw error; }
    },
    createLifeItem: async (input) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await createLifeOsItem(input, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to save this life-area item'); throw error; }
    },
    updateLifeItem: async (itemId, input) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await updateLifeOsItem(itemId, input, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to update this life-area item'); throw error; }
    },
    completeLifeItem: async (itemId) => {
      const { token } = requireDurableSession(); setSyncStatus('saving'); setSyncError(undefined);
      try { applyServerState(await completeLifeOsItem(itemId, token)); }
      catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Unable to complete this life-area item'); throw error; }
    },
  }), [accessToken, graph, isDurable, modeState, todayLoop, sessionStatus, syncError, syncStatus, todayPlan, user]);

  return <LifeGraphContext.Provider value={value}>{children}</LifeGraphContext.Provider>;
}

export function useLifeGraph(): LifeGraphContextValue {
  const value = useContext(LifeGraphContext);
  if (!value) throw new Error('useLifeGraph must be used inside LifeGraphProvider');
  return value;
}
