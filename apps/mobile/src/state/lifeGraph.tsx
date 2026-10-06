import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DailyPlan, LifeGraphSnapshot, PillarName } from '@apm/domain';
import {
  fetchTodayState,
  isApmApiConfigured,
  persistActionCompletion,
  persistOnboarding,
} from '../api/apmApi';
import { useSession } from './session';

function emptyGraph(userId = 'unassigned'): LifeGraphSnapshot {
  return {
    identity: { userId, displayName: '' },
    roles: [],
    goals: [],
    milestones: [],
    projects: [],
    commitments: [],
    nextActions: [],
    routines: [],
    people: [],
    preferences: [],
    rules: [],
    radarItems: [],
    evidence: [],
  };
}

export interface OnboardingInput {
  displayName: string;
  roles: string[];
  currentSeason?: string;
  becoming?: string;
  primaryGoal: string;
  pillar?: PillarName;
}

type SyncStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

interface LifeGraphContextValue {
  graph: LifeGraphSnapshot;
  todayPlan?: DailyPlan;
  syncStatus: SyncStatus;
  syncError?: string;
  isDurable: boolean;
  refresh: () => Promise<void>;
  completeOnboarding: (input: OnboardingInput) => Promise<void>;
  completeNextAction: (actionId: string) => Promise<void>;
}

const LifeGraphContext = createContext<LifeGraphContextValue | null>(null);

export function LifeGraphProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, user, accessToken } = useSession();
  const [graph, setGraph] = useState<LifeGraphSnapshot>(() => emptyGraph());
  const [todayPlan, setTodayPlan] = useState<DailyPlan>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string>();

  const isDurable = Boolean(
    sessionStatus === 'signed_in' && user && accessToken && isApmApiConfigured(),
  );

  const requireDurableSession = (): { userId: string; token: string } => {
    if (sessionStatus !== 'signed_in' || !user || !accessToken) {
      throw new Error('Sign in before changing your APM');
    }
    if (!isApmApiConfigured()) {
      throw new Error('The APM API is not configured for this build');
    }
    return { userId: user.id, token: accessToken };
  };

  const applyServerState = (state: { graph: LifeGraphSnapshot; plan: DailyPlan }) => {
    setGraph(state.graph);
    setTodayPlan(state.plan);
    setSyncStatus('ready');
  };

  const refresh = async () => {
    if (sessionStatus !== 'signed_in' || !user || !accessToken) {
      setGraph(emptyGraph());
      setTodayPlan(undefined);
      setSyncStatus('ready');
      return;
    }

    if (!isApmApiConfigured()) {
      setSyncStatus('error');
      setSyncError('The APM API is not configured for this build.');
      return;
    }

    setSyncStatus('loading');
    setSyncError(undefined);
    try {
      applyServerState(await fetchTodayState(accessToken));
    } catch (error) {
      setSyncStatus('error');
      setSyncError(error instanceof Error ? error.message : 'Unable to load your APM');
      throw error;
    }
  };

  useEffect(() => {
    if (sessionStatus === 'loading') return;

    if (sessionStatus !== 'signed_in' || !user || !accessToken) {
      setGraph(emptyGraph());
      setTodayPlan(undefined);
      setSyncStatus('ready');
      setSyncError(undefined);
      return;
    }

    if (!isApmApiConfigured()) {
      setGraph(emptyGraph(user.id));
      setTodayPlan(undefined);
      setSyncStatus('error');
      setSyncError('The APM API is not configured for this build.');
      return;
    }

    let active = true;
    setSyncStatus('loading');
    setSyncError(undefined);

    void fetchTodayState(accessToken)
      .then((state) => {
        if (!active) return;
        setGraph(state.graph);
        setTodayPlan(state.plan);
        setSyncStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSyncStatus('error');
        setSyncError(error instanceof Error ? error.message : 'Unable to load your APM');
      });

    return () => {
      active = false;
    };
  }, [accessToken, sessionStatus, user]);

  const value = useMemo<LifeGraphContextValue>(
    () => ({
      graph,
      todayPlan,
      syncStatus,
      syncError,
      isDurable,
      refresh,
      completeOnboarding: async (input) => {
        const { token } = requireDurableSession();
        setSyncStatus('saving');
        setSyncError(undefined);
        try {
          applyServerState(await persistOnboarding(input, token));
        } catch (error) {
          setSyncStatus('error');
          setSyncError(error instanceof Error ? error.message : 'Unable to save your APM');
          throw error;
        }
      },
      completeNextAction: async (actionId) => {
        const { token } = requireDurableSession();
        setSyncStatus('saving');
        setSyncError(undefined);
        try {
          applyServerState(await persistActionCompletion(actionId, token));
        } catch (error) {
          setSyncStatus('error');
          setSyncError(error instanceof Error ? error.message : 'Unable to record completion');
          throw error;
        }
      },
    }),
    [accessToken, graph, isDurable, sessionStatus, syncError, syncStatus, todayPlan, user],
  );

  return <LifeGraphContext.Provider value={value}>{children}</LifeGraphContext.Provider>;
}

export function useLifeGraph(): LifeGraphContextValue {
  const value = useContext(LifeGraphContext);
  if (!value) throw new Error('useLifeGraph must be used inside LifeGraphProvider');
  return value;
}
