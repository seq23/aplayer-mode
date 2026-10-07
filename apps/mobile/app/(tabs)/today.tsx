import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  ChoiceRow,
  Label,
  Pill,
  TextField,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';
import type { AgendaItem } from '@apm/planning';
import {
  approveExternalAction,
  checkInToday,
  closeDay,
  completeAgendaAction,
  decideGoalPlan,
  replanToday,
  reviewPlanGate,
  type ReplanReason,
} from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { useSession } from '../../src/state/session';

function timeLabel(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function TodayScreen() {
  const { graph, todayPlan, modeState, todayLoop, completeNextAction, isDurable, syncError, refresh, perform } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [mood, setMood] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [decision, setDecision] = useState<'promote' | 'maintain' | 'park'>();
  const [decisionReason, setDecisionReason] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const agenda = todayLoop?.agenda;
  const executionOpen = Boolean(todayLoop?.checkedIn && !todayLoop.closed);
  const hideAgenda = todayLoop?.dayStart === 'hard' && !todayLoop.checkedIn;

  const run = async (label: string, call: (token: string) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setActionError(undefined); setNotice(undefined);
    try { await call(label); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'That did not save.'); }
    finally { setBusy(false); }
  };
  const checkIn = () => mood !== undefined && run('check-in', () => perform((token) => checkInToday(mood, token)));
  const completeItem = (item: AgendaItem) => run('complete', async () => {
    if (item.planId && item.actionKey) await perform((token) => completeAgendaAction({ planId: item.planId!, actionKey: item.actionKey! }, token));
    else if (item.nextActionId) await completeNextAction(item.nextActionId);
  });
  const replan = (reason: ReplanReason) => run('replan', async () => {
    try {
      const state = await perform((token) => replanToday({ reason }, token));
      setNotice(state.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message.replace(/ \(409\).*$/, '') : undefined);
    }
  });
  // One question at a time: the first due gate, then the first due day-90 decision.
  const gateDue = agenda?.gateReviews?.[0];
  const decisionDue = agenda?.decisions?.[0];
  const goalTitleForPlan = (planId: string) => graph.goals.find((goal) => goal.id === graph.goalPlans.find((plan) => plan.id === planId)?.goalId)?.title ?? 'this goal';
  const reviewGate = (stillAligned: boolean) => gateDue && run('gate', () => perform((token) => reviewPlanGate(gateDue.planId, { gate: gateDue.gate as 'foundation' | 'build', stillAligned }, token)));
  const decide = () => decisionDue && decision && decisionReason.trim().length >= 3 && run('decide', () => perform((token) => decideGoalPlan(decisionDue.planId, { decision, reason: decisionReason.trim() }, token)));

  const itemCard = (item: AgendaItem, label?: string) => (
    <Card key={item.id} tone={item.kind === 'plan_action' ? 'accent' : 'default'}>
      {label ? <Label>{label}</Label> : null}
      <View style={uiStyles.row}>
        <Pill tone={item.status === 'done' ? 'success' : 'neutral'}>{item.status === 'done' ? 'Done' : item.scope === 'mvd' ? 'Minimum version' : item.kind.replace('_', ' ')}</Pill>
        {item.durationMinutes ? <Pill>{`${item.durationMinutes} min`}</Pill> : null}
        {item.pillar ? <Pill>{item.pillar}</Pill> : null}
      </View>
      <CardTitle>{item.title}</CardTitle>
      {item.output ? <Body muted>{`Done means: ${item.output}`}</Body> : null}
      {item.status === 'open' && executionOpen ? <Button label={busy ? 'Recording…' : 'Mark done'} onPress={() => void completeItem(item)} /> : null}
      {item.status === 'open' && !executionOpen && !todayLoop?.closed ? <Body muted>Execution starts after your check-in.</Body> : null}
    </Card>
  );
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const primaryAction = todayPlan?.numberOneMove;
  const completionEvidence = graph.evidence.find((item) => item.relatedActionId === primaryAction?.id);
  const firstRadarItem = graph.radarItems[0];
  const name = graph.identity.displayName || 'there';
  const mode = modeState?.mode ?? todayPlan?.mode ?? graph.personalOS?.activeMode ?? 'standard';
  const recovery = mode === 'recovery';
  const approvals = (todayPlan?.approvalActionIds ?? [])
    .map((id) => graph.actions.find((action) => action.id === id))
    .filter((action): action is NonNullable<typeof action> => Boolean(action));

  const complete = async () => {
    if (!primaryAction || busy) return;
    setBusy(true); setActionError(undefined);
    try { await completeNextAction(primaryAction.id); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Unable to record completion.'); }
    finally { setBusy(false); }
  };

  const approve = async (actionId: string) => {
    if (!accessToken || busyActionId) return;
    setBusyActionId(actionId); setActionError(undefined);
    try {
      await approveExternalAction(actionId, accessToken);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to execute the approved action.');
    } finally { setBusyActionId(undefined); }
  };

  const closeToday = async (verdict: 'full_day' | 'mvd' | 'miss') => {
    if (!accessToken || closing) return;
    setClosing(true); setActionError(undefined);
    try {
      await closeDay(verdict, closeNote.trim() || undefined, accessToken);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to close the day.');
    } finally { setClosing(false); }
  };

  return (
    <Screen
      eyebrow="Today"
      title={`Good morning, ${name}.`}
      subtitle={primaryGoal ? recovery ? 'Recovery Mode is active. Today protects continuity instead of demanding intensity.' : 'APM rebuilt Today from your Personal OS, Life Graph, calendar and current execution state.' : 'APM is ready to build your first durable Personal OS.'}
    >
      <View style={uiStyles.row}>
        <Pill tone={isDurable ? 'success' : 'warning'}>{isDurable ? 'Server-backed' : 'Connection needed'}</Pill>
        <Pill tone={recovery ? 'warning' : 'neutral'}>{mode.replace('_', ' ')}</Pill>
        {todayPlan ? <Pill>{todayPlan.completionState.replace('_', ' ')}</Pill> : null}
      </View>

      {!isDurable ? <Card tone="warning"><CardTitle>APM is not pretending local state is durable.</CardTitle><Body muted>{syncError ?? 'Reconnect the authenticated APM API before changing private Life Graph state.'}</Body></Card> : null}

      {modeState?.todayEffect && (mode === 'sprint' || mode === 'deep_work') ? <Card tone="accent"><Label>{mode === 'sprint' ? 'Sprint' : 'Deep Work'}</Label><CardTitle>{modeState.todayEffect.summary}</CardTitle>{modeState.todayEffect.heldBlocks.length ? <Body muted>{modeState.todayEffect.heldBlocks.length} item(s) held {mode === 'sprint' ? 'in maintenance' : 'until the block ends'}.</Body> : null}</Card> : null}

      {recovery ? <Card tone="warning"><Label>Minimum Viable Day</Label><CardTitle>One useful thing. No catch-up debt.</CardTitle><Body muted>Continuity beats intensity today. Completing the smallest critical move is enough.</Body></Card> : null}

      {!graph.personalOS ? (
        <Card tone="accent">
          <Label>Start here</Label>
          <CardTitle>Build your Personal OS so APM can plan around your actual game.</CardTitle>
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        </Card>
      ) : null}

      {todayLoop && graph.personalOS ? (
        <>
          {todayLoop.dayState.state === 'missed_yesterday' ? <Card tone="warning"><Label>Never Miss Twice</Label><CardTitle>Yesterday is closed. Today is a Recovery Day.</CardTitle><Body muted>One small thing, then close the day. Nothing from yesterday is owed.</Body></Card> : null}

          {!todayLoop.checkedIn && !todayLoop.closed ? (
            <Card tone="accent">
              <Label>{todayLoop.dayStart === 'hard' ? 'Hard Start · opening step' : 'Guided Start · opening step'}</Label>
              <CardTitle>How is your energy right now, 1 to 10?</CardTitle>
              <Body muted>{todayLoop.dayStart === 'hard' ? 'Your agenda prints after this answer.' : 'You can read the agenda below; execution starts after this answer.'} At 2 or lower, today becomes a Minimum Viable Day automatically.</Body>
              <ChoiceRow options={Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: String(i + 1) }))} value={mood} onChange={setMood} />
              <Button label={busy ? 'Printing…' : 'Print my agenda'} onPress={() => void checkIn()} />
            </Card>
          ) : null}

          {agenda && !hideAgenda ? (
            <>
              <SectionTitle>Phase 1 · Today’s agenda</SectionTitle>
              <Card>
                <Label>Foreground priority</Label>
                <CardTitle>{agenda.foregroundPriority?.label ?? 'No foreground goal yet'}</CardTitle>
                <View style={uiStyles.row}>
                  <Pill tone={agenda.mode === 'recovery' ? 'warning' : 'neutral'}>{agenda.mode === 'recovery' ? 'Minimum Viable Day' : 'Standard day'}</Pill>
                  {agenda.dayIndex ? <Pill>{`Day ${Math.max(agenda.dayIndex, 0)} of 90`}</Pill> : null}
                  <Pill>{todayLoop.locked ? 'Locked for today' : 'Preview'}</Pill>
                </View>
                {agenda.background.length ? <Body muted>{`Background (maintenance only): ${agenda.background.map((b) => b.label).join(', ')}`}</Body> : null}
              </Card>
              {agenda.firstHour.sequence.length ? (
                <Card tone="accent"><Label>The first hour</Label>{agenda.firstHour.sequence.map((step, index) => <KeyValue key={`${index}-${step}`} label={`${index + 1}`} value={step} />)}</Card>
              ) : null}
              {agenda.firstHour.priority ? itemCard(agenda.firstHour.priority, 'Priority execution') : <Card><Body>No foreground action is available. Add a goal in Goals.</Body></Card>}
              {agenda.dailyStack.length ? <SectionTitle>The daily stack</SectionTitle> : null}
              {agenda.dailyStack.map((item) => itemCard(item))}
              {agenda.problems.length ? <Card tone="warning"><Label>Invalid agenda</Label>{agenda.problems.map((problem) => <Body key={problem}>{problem}</Body>)}</Card> : null}
              {agenda.safety.referral ? <Card tone="danger"><Label>Body coaching paused</Label><Body>{agenda.safety.doctorLine ?? 'Talk to a clinician before body goals continue.'}</Body></Card> : null}
              <Card tone="muted"><Body>{agenda.bridge}</Body><Button label="Coaching first" variant="secondary" onPress={() => router.push('/(tabs)/apm')} /></Card>
            </>
          ) : null}

          {gateDue && !hideAgenda ? (
            <Card tone="warning">
              <Label>{`${gateDue.label} · ${goalTitleForPlan(gateDue.planId)}`}</Label>
              <CardTitle>{`Recommended: ${gateDue.recommended}. ${gateDue.completedDays} days with evidence.`}</CardTitle>
              <Body muted>Is this goal still aligned with what you want?</Body>
              <Button label="Still aligned" onPress={() => void reviewGate(true)} />
              <Button label="Not aligned any more" variant="secondary" onPress={() => void reviewGate(false)} />
            </Card>
          ) : null}

          {decisionDue && !hideAgenda ? (
            <Card tone="warning">
              <Label>Day 90 · forced decision</Label>
              <CardTitle>{`${goalTitleForPlan(decisionDue.planId)}: Promote, Maintain or Park? APM recommends ${decisionDue.recommended}.`}</CardTitle>
              {decisionDue.criteria.map((line) => <Body key={line} muted>{line}</Body>)}
              <ChoiceRow options={[{ id: 'promote', label: 'Promote' }, { id: 'maintain', label: 'Maintain' }, { id: 'park', label: 'Park' }]} value={decision} onChange={setDecision} />
              <TextField value={decisionReason} onChangeText={setDecisionReason} placeholder="One line why" />
              <Button label="Record the decision" onPress={() => void decide()} />
              <Body muted>Parking is a successful outcome: it is a strategic allocation choice.</Body>
            </Card>
          ) : null}

          {todayLoop.locked && !todayLoop.closed ? (
            <Card>
              <Label>Something changed?</Label>
              <Body muted>The morning plan stands. Only a real external change, a safety issue or a permission change reopens it.</Body>
              <ChoiceRow<ReplanReason> options={[{ id: 'external_change', label: 'External change' }, { id: 'safety', label: 'Safety / sick' }, { id: 'permission', label: 'Permission changed' }, { id: 'mood', label: 'I feel tired' }]} onChange={(reason) => void replan(reason)} />
            </Card>
          ) : null}
          {notice ? <Card tone="muted"><Body>{notice}</Body></Card> : null}
        </>
      ) : null}

      {actionError ? <Card tone="danger"><Body>{actionError}</Body></Card> : null}

      {hideAgenda ? <Card tone="muted"><Body>Hard Start: Radar, your run of show, approvals and the close appear after the opening step.</Body></Card> : (
        <>
      {completionEvidence ? <Card><Label>Evidence recorded</Label><CardTitle>{completionEvidence.summary}</CardTitle><KeyValue label="Source" value="You marked it complete" /><KeyValue label="Recorded" value={new Date(completionEvidence.createdAt).toLocaleString()} /></Card> : null}

      {!recovery ? (
        <>
          <SectionTitle>APM noticed</SectionTitle>
          {firstRadarItem ? <Card tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'default'}><Pill tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'neutral'}>{firstRadarItem.type} · {firstRadarItem.severity}</Pill><CardTitle>{firstRadarItem.headline}</CardTitle><Body muted>{firstRadarItem.summary}</Body><Button label="Why am I seeing this?" variant="secondary" onPress={() => router.push({ pathname: '/radar/why', params: { id: firstRadarItem.id } })} /></Card> : <Card tone="muted"><CardTitle>Radar is clear for now.</CardTitle><Body muted>APM found no high-value signal it can justify surfacing right now.</Body></Card>}
        </>
      ) : null}

      <SectionTitle>Your run of show</SectionTitle>
      <View style={uiStyles.stack}>
        {(todayPlan?.blocks.length ?? 0) ? todayPlan!.blocks.map((block) => (
          <Card key={block.id}>
            <View style={uiStyles.row}><Pill>{block.source ?? 'plan'}</Pill>{block.startAt ? <Pill>{timeLabel(block.startAt)}{block.endAt ? `–${timeLabel(block.endAt)}` : ''}</Pill> : null}</View>
            <CardTitle>{block.title}</CardTitle>
          </Card>
        )) : <Card><Body muted>No calendar or execution blocks are available yet.</Body></Card>}
      </View>

      {approvals.length ? (
        <>
          <SectionTitle>Needs your approval</SectionTitle>
          {approvals.map((action) => <Card key={action.id} tone="warning"><Label>{action.domain} · {action.actionType}</Label><CardTitle>{action.reason}</CardTitle><Body muted>APM prepared this action but has not executed it. Your subscription does not grant permission; this approval is explicit.</Body><Button label={busyActionId === action.id ? 'Executing…' : 'Approve & execute'} onPress={() => void approve(action.id)} /></Card>)}
        </>
      ) : null}

      <SectionTitle>Open loops</SectionTitle>
      <Card>
        <KeyValue label="Commitments" value={String(todayPlan?.commitmentIds.length ?? 0)} />
        <KeyValue label="Routines" value={String(todayPlan?.routineIds.length ?? 0)} />
        <KeyValue label="Radar items" value={String(todayPlan?.radarItemIds.length ?? 0)} />
      </Card>

      {graph.personalOS ? <Card><Label>Personal OS</Label><KeyValue label="Day start" value={graph.personalOS.accountability.dayStart === 'hard' ? 'Hard Start' : 'Guided Start'} /><KeyValue label="Tracks" value={graph.tracks.filter((track) => track.active).map((track) => track.name).join(', ') || 'None'} /><Button label="Open APM Coach" variant="secondary" onPress={() => router.push('/(tabs)/apm')} /></Card> : null}

      <SectionTitle>Close the day</SectionTitle>
      <Card>
        <Body muted>Closing records evidence for continuity. No catch-up is created for tomorrow.</Body>
        <TextField value={closeNote} onChangeText={setCloseNote} placeholder="A note for today (optional)" />
        {todayLoop && !todayLoop.checkedIn ? <Body muted>A Full Day or MVD needs the check-in first. Without it, today can only close as a Miss.</Body> : (
          <>
            <Button label={closing ? 'Saving…' : 'Full Day'} onPress={() => void closeToday('full_day')} />
            <Button label="Minimum Viable Day" variant="secondary" onPress={() => void closeToday('mvd')} />
          </>
        )}
        <Button label="Miss" variant="secondary" onPress={() => void closeToday('miss')} />
      </Card>

        </>
      )}

      <SectionTitle>Trust & control</SectionTitle>
      <Card><CardTitle>See exactly how APM works with your information.</CardTitle><Body muted>Inspect your data, AI processing, providers, connections, permissions and activity.</Body><Button label="Open Privacy & AI" variant="secondary" onPress={() => router.push('/settings/privacy')} /><Button label="Settings" variant="secondary" onPress={() => router.push('/settings')} /></Card>
    </Screen>
  );
}
