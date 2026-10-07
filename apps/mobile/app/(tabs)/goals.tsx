import { router } from 'expo-router';
import { AREA_OPTIONS, areaDisplay } from '../../src/content/areas';
import { useState } from 'react';
import { View } from 'react-native';
import type { AreaKey, StoredGoalPlan } from '@apm/domain';
import { classifySuggestedArea, type GoalPlan } from '@apm/planning';
import {
  Body,
  Button,
  Card,
  CardTitle,
  EmptyState,
  ChoiceRow,
  ErrorState,
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
import { plainError } from '../../src/api/errors';
import { GATE_WORDS, GOAL_HEALTH_WORDS, GOAL_STATUS_WORDS, TARGET_HORIZONS, shortDate, targetDateFor } from '../../src/content/words';

const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

const healthTone = {
  on_track: 'success',
  at_risk: 'warning',
  stalled: 'danger',
  unknown: 'neutral',
} as const;

const PILLARS = [...AREA_OPTIONS];

function dayIndex(startDate: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function PlanView({ stored, today }: { stored: StoredGoalPlan<GoalPlan>; today: string }) {
  const plan = stored.plan;
  const day = Math.max(0, Math.min(90, dayIndex(plan.startDate, today)));
  return (
    <View style={uiStyles.stack}>
      <KeyValue label="Plan" value={`Day ${day} of 90 · ${plan.foreground.label}`} />
      {stored.decision ? <KeyValue label="Day-90 decision" value={`${sentence(GATE_WORDS[stored.decision] ?? 'decided')}${stored.decisionReason ? ` — ${stored.decisionReason}` : ''}`} /> : null}
      {plan.gates.map((gate) => (
        <View key={gate.key} style={uiStyles.stack}>
          <Label>{`${gate.label} · ${shortDate(gate.startDate)} to ${shortDate(gate.endDate)}${stored.gateReviews[gate.key] ? ' · checked' : ''}`}</Label>
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
  const [pillar, setPillar] = useState<AreaKey>();
  const [horizon, setHorizon] = useState<string>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreatedGoalState>();
  const [choosingArea, setChoosingArea] = useState(false);
  // APM files the goal under an area from its words; the person only changes it if it is wrong (docs/35 U1).
  const autoArea = title.trim().length >= 3 ? classifySuggestedArea(title).area : undefined;
  const area = pillar ?? autoArea;
  const today = todayLoop?.date ?? new Date().toISOString().slice(0, 10);
  const plans = graph.goalPlans as unknown as Array<StoredGoalPlan<GoalPlan>>;
  const foregroundGoalId = graph.personalOS?.foregroundGoalId;

  const add = async () => {
    if (busy) return;
    if (title.trim().length < 3) { setError('Write the goal in a few words first, e.g. "Run a 5K by June".'); return; }
    const targetDate = targetDateFor(horizon);
    setBusy(true); setError(undefined); setCreated(undefined);
    try {
      const state = await perform((token) => createGoal({ title: title.trim(), ...(area ? { pillar: area } : {}), ...(targetDate ? { targetDate } : {}) }, token));
      setCreated(state); setTitle(''); setPillar(undefined); setHorizon('none'); setChoosingArea(false);
    } catch (cause) { setError(plainError(cause, 'The goal was not added. Try again.')); }
    finally { setBusy(false); }
  };
  const [movingId, setMovingId] = useState<string>();
  const makeForeground = async (goalId: string) => {
    if (busy) return;
    setBusy(true); setMovingId(goalId); setError(undefined);
    try { await perform((token) => setForegroundGoal(goalId, token)); setCreated(undefined); }
    catch (cause) { setError(plainError(cause, 'Your main goal did not change. Try again.')); }
    finally { setBusy(false); setMovingId(undefined); }
  };
  const recommended = created?.recommendedForegroundGoalId;

  return (
    <Screen
      eyebrow="Goals"
      title="Where APM is taking you."
      subtitle="APM turns each goal into a 90-day plan with one small step a day. One goal is your main goal; the others tick over in the background."
    >
      {error ? <ErrorState message={error} /> : null}
      {graph.goals.length ? (
        <View style={uiStyles.stack}>
          {graph.goals.map((goal) => {
            const stored = plans.find((plan) => plan.goalId === goal.id);
            const isForeground = goal.id === foregroundGoalId;
            return (
              <Card key={goal.id} tone={isForeground ? 'accent' : 'default'}>
                <View style={uiStyles.row}>
                  <Pill tone={isForeground && healthTone[goal.health] === 'success' ? 'solid' : healthTone[goal.health]}>{GOAL_HEALTH_WORDS[goal.health] ?? 'Just started'}</Pill>
                  {isForeground ? <Pill tone="solid">Main goal</Pill> : null}
                  {goal.status !== 'active' ? <Pill>{GOAL_STATUS_WORDS[goal.status] ?? 'Paused'}</Pill> : null}
                </View>
                <CardTitle>{goal.title}</CardTitle>
                <KeyValue label="Area" value={areaDisplay(goal.pillar)} />
                {goal.targetDate ? <KeyValue label="Target date" value={shortDate(goal.targetDate) || goal.targetDate} /> : null}
                {stored ? <PlanView stored={stored} today={today} /> : <Body muted>The plan is being built; it appears on your next refresh.</Body>}
                {!isForeground && goal.status === 'active' ? <Button label={movingId === goal.id ? 'Saving…' : 'Make this my main goal'} variant="secondary" busy={movingId === goal.id} disabled={busy && movingId !== goal.id} onPress={() => makeForeground(goal.id)} /> : null}
              </Card>
            );
          })}
        </View>
      ) : (
        <EmptyState icon="target" title="No goal yet." body="Answer a few quick questions and APM turns your goal into a 90-day plan with one small step a day." actionLabel="Set up my plan" onAction={() => router.push('/intake')} />
      )}

      {created?.arbitration ? (
        <Card tone="warning">
          <Label>Which goal comes first?</Label>
          <CardTitle>{recommended && recommended !== foregroundGoalId ? 'APM suggests making the new goal your main goal.' : 'Your main goal stays first. The new goal ticks over in the background.'}</CardTitle>
          {created.arbitration.ranked.map((row, index) => {
            const goalId = plans.find((plan) => plan.id === row.id)?.goalId;
            return <KeyValue key={row.id} label={index === 0 ? 'First' : `${index + 1}.`} value={graph.goals.find((goal) => goal.id === goalId)?.title ?? 'Goal'} />;
          })}
          <Body muted>APM weighs payoff, real deadlines, your energy, how it builds over time and what could go wrong. You decide.</Body>
          {recommended && recommended !== foregroundGoalId ? <Button label="Make it my main goal" onPress={() => makeForeground(recommended)} /> : null}
        </Card>
      ) : null}

      {graph.personalOS ? (
        <>
          <SectionTitle>Add a goal</SectionTitle>
          <Card>
            <Body muted>Write it in a few words. APM files it, plans it and tells you whether it should come first. In your first week new goals wait, so the basics settle.</Body>
            <TextField label="Goal" value={title} onChangeText={setTitle} placeholder="e.g. Build a 3-month emergency fund" />
            {area ? <Body muted>{`APM files this under ${areaDisplay(area)}.`}</Body> : null}
            {choosingArea ? <ChoiceRow options={PILLARS} value={area} onChange={(next) => { setPillar(next); setChoosingArea(false); }} />
              : area ? <Button label="Change the area" variant="secondary" onPress={() => setChoosingArea(true)} /> : null}
            <Label>By when? (optional)</Label>
            <ChoiceRow options={TARGET_HORIZONS.map((h) => ({ id: h.id, label: h.label }))} value={horizon} onChange={setHorizon} />
            <Button label={busy && !movingId ? 'Planning…' : 'Add goal and build its plan'} busy={busy && !movingId} disabled={title.trim().length < 3} disabledReason="Write the goal in a few words first." onPress={() => add()} />
          </Card>
        </>
      ) : null}

      <SectionTitle>How progress works</SectionTitle>
      <Card>
        <Body>Your goal becomes three 30-day stages, each with checkpoints. Every day you get one small step. On day 90 you choose: make it your main goal, keep it going, or park it.</Body>
      </Card>
    </Screen>
  );
}
