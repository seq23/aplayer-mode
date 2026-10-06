import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type {
  Evidence,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  PillarName,
  Provenance,
  UserIdentity,
} from '@apm/domain';

const now = () => new Date().toISOString();
const userId = 'local-user';

const emptyIdentity: UserIdentity = {
  userId,
  displayName: '',
};

const initialGraph: LifeGraphSnapshot = {
  identity: emptyIdentity,
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

const statedProvenance = (): Provenance => ({
  kind: 'stated',
  sourceType: 'manual',
  createdAt: now(),
  confidence: 1,
});

interface OnboardingInput {
  displayName: string;
  currentSeason?: string;
  becoming?: string;
  primaryGoal: string;
  pillar?: PillarName;
}

interface LifeGraphContextValue {
  graph: LifeGraphSnapshot;
  completeOnboarding: (input: OnboardingInput) => void;
  completeNextAction: (actionId: string) => void;
}

const LifeGraphContext = createContext<LifeGraphContextValue | null>(null);

export function LifeGraphProvider({ children }: { children: ReactNode }) {
  const [graph, setGraph] = useState<LifeGraphSnapshot>(initialGraph);

  const value = useMemo<LifeGraphContextValue>(
    () => ({
      graph,
      completeOnboarding: (input) => {
        const timestamp = Date.now();
        const identity: UserIdentity = {
          userId,
          displayName: input.displayName.trim(),
          currentSeason: input.currentSeason?.trim() || undefined,
          becoming: input.becoming?.trim() || undefined,
        };

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

        setGraph((current) => ({
          ...current,
          identity,
          goals: [goal, ...current.goals.filter((item) => item.priority !== 1)],
          nextActions: [nextAction, ...current.nextActions.filter((item) => item.goalId !== goal.id)],
        }));
      },
      completeNextAction: (actionId) => {
        setGraph((current) => {
          const action = current.nextActions.find((item) => item.id === actionId);
          if (!action || action.status === 'done') return current;

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

          return {
            ...current,
            nextActions: current.nextActions.map((item) =>
              item.id === actionId ? { ...item, status: 'done' as const } : item,
            ),
            evidence: [evidence, ...current.evidence],
          };
        });
      },
    }),
    [graph],
  );

  return <LifeGraphContext.Provider value={value}>{children}</LifeGraphContext.Provider>;
}

export function useLifeGraph(): LifeGraphContextValue {
  const value = useContext(LifeGraphContext);
  if (!value) throw new Error('useLifeGraph must be used inside LifeGraphProvider');
  return value;
}
