import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  Evidence,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  PillarName,
  Provenance,
  Role,
  UserIdentity,
} from '@apm/domain';
import {
  fetchLifeGraph,
  isApmApiConfigured,
  persistActionCompletion,
  persistOnboarding,
} from '../api/apmApi';
import { useSession } from './session';

const now = () => new Date().toISOString();
const localUserId = 'local-user';

function emptyGraph(userId = localUserId): LifeGraphSnapshot {
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

const statedProvenance = (): Provenance => ({
  kind: 'stated',
  sourceType: 'manual',
  createdAt: now(),
  confidence: 1,
});

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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string>();

  const isDurable = Boolean(accessToken && isApmApiConfigured());

  const refresh = async () => {
    if (!accessToken || !isApmApiConfigured()) {
      setSyncStatus('ready');
      return;
    }

    setSyncStatus('loading');
    setSyncError(undefined);
    try {
      const serverGraph = await fetchLifeGraph(accessToken);
      setGraph(serverGraph);
      setSyncStatus('ready');
    } catch (error) {
      setSyncStatus('error');
      setSyncError(error instanceof Error ? error.message : 'Unable to load your APM');
      throw error;
    }
  };

  useEffect(() => {
    if (sessionStatus === 'loading') return;

    if (sessionStatus !== 'signed_in' || !user) {
      setGraph(emptyGraph());
      setSyncStatus('ready');
      setSyncError(undefined);
      return;
    }

    if (!isApmApiConfigured() || !accessToken) {
      setGraph((current) => ({
        ...current,
        identity: { ...current.identity, userId: user.id },
      }));
      setSyncStatus('ready');
      return;
    }

    let active = true;
    setSyncStatus('loading');
    setSyncError(undefined);

    void fetchLifeGraph(accessToken)
      .then((serverGraph) => {
        if (!active) return;
        setGraph(serverGraph);
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
      syncStatus,
      syncError,
      isDurable,
      refresh,
      completeOnboarding: async (input) => {
        const timestamp = Date.now();
        const userId = user?.id ?? localUserId;
        const identity: UserIdentity = {
          userId,
          displayName: input.displayName.trim(),
          currentSeason: input.currentSeason?.trim() || undefined,
          becoming: input.becoming?.trim() || undefined,
        };

        const roles: Role[] = input.roles.map((name, index) => ({
          id: `role-${timestamp}-${index}`,
          userId,
          name,
          active: true,
          provenance: statedProvenance(),
        }));

        const goal: Goal = {
          id: `goal-${timestamp}`,
          userId,
          title: input.primaryGoal.trim(),
          status: 'active',
          health: 'unknown',
          pillar: input.pillar,
          priority: 1,
          provenance: statedProvenance(),
        };

        const nextAction: NextAction = {
          id: `action-${timestamp}`,
          userId,
          goalId: goal.id,
          title: `Spend 45 focused minutes advancing: ${goal.title}`,
          status: 'open',
          estimatedMinutes: 45,
        };

        const optimisticGraph: LifeGraphSnapshot = {
          ...graph,
          identity,
          roles,
          goals: [goal, ...graph.goals.filter((item) => item.priority !== 1)],
          nextActions: [nextAction, ...graph.nextActions.filter((item) => item.goalId !== goal.id)],
        };
        setGraph(optimisticGraph);

        if (!accessToken || !isApmApiConfigured()) {
          setSyncStatus('ready');
          return;
        }

        setSyncStatus('saving');
        setSyncError(undefined);
        try {
          const serverGraph = await persistOnboarding(input, accessToken);
          setGraph(serverGraph);
          setSyncStatus('ready');
        } catch (error) {
          setSyncStatus('error');
          setSyncError(error instanceof Error ? error.message : 'Unable to save your APM');
          throw error;
        }
      },
      completeNextAction: async (actionId) => {
        const previousGraph = graph;
        const action = graph.nextActions.find((item) => item.id === actionId);
        if (!action || action.status === 'done') return;

        const userId = user?.id ?? localUserId;
        const evidence: Evidence = {
          id: `evidence-${Date.now()}`,
          userId,
          kind: 'user_completion',
          summary: `User marked complete: ${action.title}`,
          sourceType: 'manual',
          relatedGoalId: action.goalId,
          relatedActionId: action.id,
          createdAt: now(),
        };

        setGraph({
          ...graph,
          nextActions: graph.nextActions.map((item) =>
            item.id === actionId ? { ...item, status: 'done' as const } : item,
          ),
          evidence: [evidence, ...graph.evidence],
        });

        if (!accessToken || !isApmApiConfigured()) return;

        setSyncStatus('saving');
        setSyncError(undefined);
        try {
          await persistActionCompletion(actionId, accessToken);
          const serverGraph = await fetchLifeGraph(accessToken);
          setGraph(serverGraph);
          setSyncStatus('ready');
        } catch (error) {
          setGraph(previousGraph);
          setSyncStatus('error');
          setSyncError(error instanceof Error ? error.message : 'Unable to record completion');
          throw error;
        }
      },
    }),
    [accessToken, graph, isDurable, syncError, syncStatus, user],
  );

  return <LifeGraphContext.Provider value={value}>{children}</LifeGraphContext.Provider>;
}

export function useLifeGraph(): LifeGraphContextValue {
  const value = useContext(LifeGraphContext);
  if (!value) throw new Error('useLifeGraph must be used inside LifeGraphProvider');
  return value;
}
