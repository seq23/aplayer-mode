import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Goal, LifeGraphSnapshot, PillarName, Provenance, UserIdentity } from '@apm/domain';

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
}

const LifeGraphContext = createContext<LifeGraphContextValue | null>(null);

export function LifeGraphProvider({ children }: { children: ReactNode }) {
  const [graph, setGraph] = useState<LifeGraphSnapshot>(initialGraph);

  const value = useMemo<LifeGraphContextValue>(
    () => ({
      graph,
      completeOnboarding: (input) => {
        const identity: UserIdentity = {
          userId,
          displayName: input.displayName.trim(),
          currentSeason: input.currentSeason?.trim() || undefined,
          becoming: input.becoming?.trim() || undefined,
        };

        const goal: Goal = {
          id: `goal-${Date.now()}`,
          userId,
          title: input.primaryGoal.trim(),
          status: 'active',
          health: 'unknown',
          pillar: input.pillar,
          priority: 1,
          provenance: statedProvenance(),
        };

        setGraph((current) => ({
          ...current,
          identity,
          goals: [goal, ...current.goals.filter((item) => item.priority !== 1)],
        }));
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
