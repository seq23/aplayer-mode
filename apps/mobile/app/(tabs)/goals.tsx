import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { PillarName, StoredGoalPlan } from '@apm/domain';
import type { GoalPlan } from '@apm/planning';
import {
  Body,
  Button,
  Card,
  CardTitle,
  ChoiceRow,
  KeyValue,
  Label,
  Pill,
  Screen,
  SectionTitle,
  TextField,
  uiStyles,
} from '../../src/components/ui';
import { createGoal, setForegroundGoal, type CreatedGoalState } from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';

const healthTone = {
  on_track: 'success',
  at_risk: 'warning',
  stalled: 'danger',
  unknown: 'neutral',
} as const;

const PILLARS: Array<{ id: PillarName; label: string }> = [
  { id: 'body', label: 'Body' }, { id: 'wealth', label: 'Wealth' },
  { id: 'spirit', label: 'Spirit' }, { id: 'execution', label: 'Execution' },
];

function dayIndex(startDate: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function PlanView({ stored, today }: { stored: StoredGoalPlan<GoalPlan>; today: string }) {
  const plan = stored.plan;
  const day = Math.max(0, Math.min(90, dayIndex(plan.startDate, today)));
  return (
    <View style={uiStyles.stack}>
      <KeyValue label="Plan" value={`Day ${day} of 90 · ${plan.foreground.label}`} />
      {stored.decision ? <KeyValue label="Day-90 decision" value={`${stored.decision}${stored.decisionReason ? ` — ${stored.decisionReason}` : ''}`} /> : null}
      {plan.gates.map((gate) => (
        <View key={gate.key} style={uiStyles.stack}>
          <Label>{`${gate.label} · days ${gate.startDay}–${gate.endDay} (${gate.startDate} → ${gate.endDate})${stored.gateReviews[gate.key] ? ` · reviewed: ${stored.gateReviews[gate.key]!.verdict}` : ''}`}</Label>
          <Body>{gate.outcome}</Body>
          {gate.milestones.map((milestone) => <Body key={milestone.id} muted>{`Day ${milestone.dueDay}: ${milestone.title}`}</Body>)}
        </View>
      ))}
      {plan.safety.doctorLine ? <Body muted>{plan.safety.doctorLine}</Body> : null}
      {plan.safety.notes.map((note) => <Body key={note} muted>{note}</Body>)}
    </View>
  );
}

export default function GoalsScreen() {
  const { graph, todayLoop, perform } = useLifeGraph();
  const [title, setTitle] = useState('');
  const [pillar, setPillar] = useState<PillarName>();
  const [targetDate, setTargetDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreatedGoalState>();
  const today = todayLoop?.date ?? new Date().toISOString().slice(0, 10);
  const plans = graph.goalPlans as unknown as Array<StoredGoalPlan<GoalPlan>>;
  const foregroundGoalId = graph.personalOS?.foregroundGoalId;

  const add = async () => {
    if (busy || title.trim().length < 3) return;
    setBusy(true); setError(undefined); setCreated(undefined);
    try {
      const state = await perform((token) => createGoal({ title: title.trim(), ...(pillar ? { pillar } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? { targetDate } : {}) }, token));
      setCreated(state); setTitle(''); setPillar(undefined); setTargetDate('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add the goal.'); }
    finally { setBusy(false); }
  };
  const makeForeground = async (goalId: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await perform((token) => setForegroundGoal(goalId, token)); setCreated(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to change the foreground.'); }
    finally { setBusy(false); }
  };
  const recommended = created?.recommendedForegroundGoalId;

  return (
    <Screen
      eyebrow="Goals"
      title="Where APM is taking you."
      subtitle="Every goal becomes a 90-day plan: three gates, milestones, and one physical action each day. One goal is the foreground; the rest get maintenance only."
    >
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      {graph.goals.length ? (
        <View style={uiStyles.stack}>
          {graph.goals.map((goal) => {
            const stored = plans.find((plan) => plan.goalId === goal.id);
            const isForeground = goal.id === foregroundGoalId;
            return (
              <Card key={goal.id} tone={isForeground ? 'accent' : 'default'}>
                <View style={uiStyles.row}>
                  <Pill tone={healthTone[goal.health]}>{goal.health.replace('_', ' ')}</Pill>
                  {isForeground ? <Pill tone="success">Foreground</Pill> : <Pill>Background</Pill>}
                  <Pill>{goal.status}</Pill>
                </View>
                <CardTitle>{goal.title}</CardTitle>
                <KeyValue label="Pillar" value={goal.pillar ?? 'Not set'} />
                {goal.targetDate ? <KeyValue label="Target date" value={goal.targetDate} /> : null}
                {stored ? <PlanView stored={stored} today={today} /> : <Body muted>The plan is being built; it appears on your next refresh.</Body>}
                {!isForeground && goal.status === 'active' ? <Button label={busy ? 'Saving…' : 'Make this the foreground'} variant="secondary" onPress={() => void makeForeground(goal.id)} /> : null}
              </Card>
            );
          })}
        </View>
      ) : (
        <Card tone="accent">
          <CardTitle>No goal in your Life Graph yet.</CardTitle>
          <Body muted>Start with one concrete 90-day outcome. APM turns it into a plan and a daily action.</Body>
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        </Card>
      )}

      {created?.arbitration ? (
        <Card tone="warning">
          <Label>Arbitration Engine</Label>
          <CardTitle>{recommended && recommended !== foregroundGoalId ? 'The new goal scores higher than your current foreground.' : 'Your current foreground still wins. The new goal runs in the background.'}</CardTitle>
          {created.arbitration.ranked.map((row) => {
            const goalId = plans.find((plan) => plan.id === row.id)?.goalId;
            return <KeyValue key={row.id} label={graph.goals.find((goal) => goal.id === goalId)?.title ?? 'Goal'} value={row.score.toFixed(2)} />;
          })}
          <Body muted>Leverage, urgency (real deadlines only), energy match, compounding and downside. You decide.</Body>
          {recommended && recommended !== foregroundGoalId ? <Button label="Move the foreground" onPress={() => void makeForeground(recommended)} /> : null}
        </Card>
      ) : null}

      {graph.personalOS ? (
        <>
          <SectionTitle>Add a goal</SectionTitle>
          <Card>
            <Body muted>A new goal is run through the Arbitration Engine against your foreground. In Week 1 no new projects are added: the system stabilises first.</Body>
            <TextField label="Goal" value={title} onChangeText={setTitle} placeholder="e.g. Build a 3-month emergency fund" />
            <Label>Pillar</Label>
            <ChoiceRow options={PILLARS} value={pillar} onChange={setPillar} />
            <TextField label="Target date (optional, YYYY-MM-DD)" value={targetDate} onChangeText={setTargetDate} placeholder="2027-01-31" />
            <Button label={busy ? 'Planning…' : 'Add goal and build its plan'} onPress={() => void add()} />
          </Card>
        </>
      ) : null}

      <SectionTitle>How progress works</SectionTitle>
      <Card>
        <Body>Goal → 30/60/90 gates → milestones → today’s one action → evidence → day-90 Promote, Maintain or Park.</Body>
      </Card>
    </Screen>
  );
}
