import { router } from 'expo-router';
import { useState } from 'react';
import {
  Body,
  Button,
  Card,
  CardTitle,
  ChoiceRow,
  Disclosure,
  Divider,
  EmptyState,
  ErrorState,
  Fill,
  Heading,
  KeyValue,
  Label,
  LinkButton,
  ListRow,
  Muted,
  Pill,
  Row,
  Screen,
  SectionTitle,
  Small,
  Stack,
  TextField,
  Toast,
} from '../../src/components/ui';
import type { AgendaItem } from '@apm/planning';
import {
  approveExternalAction,
  checkInToday,
  closeToday,
  completeAgendaAction,
  decideGoalPlan,
  replanToday,
  recordClinicianClearance,
  reprintToday,
  returnAndReset,
  reviewPlanGate,
  setTodayPhase,
  type ReplanReason,
} from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { areaDisplay } from '../../src/content/areas';
import { BedRoutineToday, CoachingModeChips, PillarRollUpLine, PracticesToday, QuickTaps, SaveAccountBanner } from '../../src/components/today/FirstRunCards';
import { useSession } from '../../src/state/session';
import { sourceAccountLabel } from '../../src/integrations/accounts';
import { hasDailyLoopAccess, noPlanCopy } from '../../src/billing/access';
import { billingAvailability } from '../../src/billing/purchases';
import { plainError } from '../../src/api/errors';
import { greeting } from '../../src/content/greeting';

function timeLabel(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function TodayScreen() {
  const { graph, todayPlan, modeState, todayLoop, completeNextAction, isDurable, syncStatus, refresh, perform } = useLifeGraph();
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
  const [carry, setCarry] = useState('');
  const [pillarScores, setPillarScores] = useState<Record<string, 'hit' | 'partial' | 'miss'>>({});
  const [verdictOverride, setVerdictOverride] = useState<'full_day' | 'mvd' | 'miss'>();
  const agenda = todayLoop?.agenda;
  const executionOpen = Boolean(todayLoop?.checkedIn && !todayLoop.closed);
  const planItems = [agenda?.firstHour.priority, ...(agenda?.dailyStack ?? [])].filter((item): item is AgendaItem => Boolean((item?.planId && item.actionKey) || item?.nextActionId));
  const planItemCount = planItems.length;
  const doneCount = planItems.filter((item) => item.status === 'done').length;
  const hideAgenda = (todayLoop?.dayStart === 'hard' && !todayLoop.checkedIn) || Boolean(todayLoop?.redacted);
  // Phase Bridge: the First Hour starts on the user's word; the Daily Stack opens after it.
  const phaseOpen = Boolean(todayLoop?.phase);
  const stackOpen = todayLoop?.phase === 'executing';
  const drifting = Boolean(todayLoop?.drift.drifting && !todayLoop.drift.acknowledged);

  const run = async (label: string, call: (token: string) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setActionError(undefined); setNotice(undefined);
    try { await call(label); }
    catch (error) { setActionError(plainError(error, 'That did not save. Try again.')); }
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
      setNotice(plainError(error, 'The plan stands for today.'));
    }
  });
  // One question at a time: the first due gate, then the first due day-90 decision.
  const gateDue = agenda?.gateReviews?.[0];
  const decisionDue = agenda?.decisions?.[0];
  const goalTitleForPlan = (planId: string) => graph.goals.find((goal) => goal.id === graph.goalPlans.find((plan) => plan.id === planId)?.goalId)?.title ?? 'this goal';
  const reviewGate = (stillAligned: boolean) => gateDue && run('gate', () => perform((token) => reviewPlanGate(gateDue.planId, { gate: gateDue.gate as 'foundation' | 'build', stillAligned }, token)));
  // Day 90: APM's recommendation is pre-selected and the "why" is optional; one tap records it (docs/35 U5).
  const chosenDecision = decision ?? decisionDue?.recommended;
  const decide = () => decisionDue && chosenDecision && run('decide', () => perform((token) => decideGoalPlan(decisionDue.planId, {
    decision: chosenDecision,
    reason: decisionReason.trim().length >= 3 ? decisionReason.trim() : `${chosenDecision === decisionDue.recommended ? 'Went with' : 'Chose over'} APM's recommendation (${decisionDue.recommended}).`,
  }, token)));
  // No plan yet (or a lapsed one): Today offers the plan, never a check-in the server refuses (docs/35 E5).
  const loopOpen = hasDailyLoopAccess(graph.entitlement);
  const planCopy = noPlanCopy(billingAvailability().available);

  const itemCard = (item: AgendaItem, label?: string) => (
    <Card key={item.id} tone={item.kind === 'plan_action' ? 'accent' : 'default'}>
      {label ? <Label tone="accent">{label}</Label> : null}
      <Row wrap gap="xs">
        <Pill tone={item.status === 'done' ? 'success' : 'neutral'}>{item.status === 'done' ? 'Done' : item.scope === 'mvd' ? 'Minimum version' : ITEM_KIND_WORDS[item.kind]}</Pill>
        {item.durationMinutes ? <Pill>{`${item.durationMinutes} min`}</Pill> : null}
        {item.pillar ? <Pill>{areaDisplay(item.pillar)}</Pill> : null}
      </Row>
      <CardTitle>{item.title}</CardTitle>
      {item.output ? <Body muted>{`Done means: ${item.output}`}</Body> : null}
      {item.status === 'open' && executionOpen && phaseOpen ? <Button label={busy ? 'Recording…' : 'Mark done'} onPress={() => void completeItem(item)} /> : null}
      {item.status === 'open' && executionOpen && phaseOpen && todayLoop?.locked ? <Button label="Not a physical action? Rewrite it" variant="ghost" onPress={() => void reprint([item.id])} /> : null}
      {item.status === 'open' && !executionOpen && !todayLoop?.closed ? <Body muted>Execution starts after your check-in.</Body> : null}
    </Card>
  );
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const primaryAction = todayPlan?.numberOneMove;
  const completionEvidence = graph.evidence.find((item) => item.relatedActionId === primaryAction?.id);
  const firstRadarItem = graph.radarItems[0];
  const name = graph.identity.displayName || 'there';
  const mode = modeState?.mode ?? todayPlan?.mode ?? graph.personalOS?.activeMode ?? 'standard';
  // The agenda's own state counts: a mood-2 day or a missed yesterday is an MVD even outside Recovery Mode.
  const recovery = mode === 'recovery' || todayLoop?.agenda.mode === 'recovery';
  const approvals = (todayPlan?.approvalActionIds ?? [])
    .map((id) => graph.actions.find((action) => action.id === id))
    .filter((action): action is NonNullable<typeof action> => Boolean(action));

  const complete = async () => {
    if (!primaryAction || busy) return;
    setBusy(true); setActionError(undefined);
    try { await completeNextAction(primaryAction.id); }
    catch (error) { setActionError(plainError(error, 'That did not record. Try again.')); }
    finally { setBusy(false); }
  };

  const approve = async (actionId: string) => {
    if (!accessToken || busyActionId) return;
    setBusyActionId(actionId); setActionError(undefined);
    try {
      await approveExternalAction(actionId, accessToken);
      await refresh();
    } catch (error) {
      setActionError(plainError(error, 'That action did not run. Nothing was sent; try again.'));
    } finally { setBusyActionId(undefined); }
  };

  const beginPhase = (phase: 'first_hour' | 'executing') => run('phase', () => perform((token) => setTodayPhase(phase, token)));
  const reprint = (itemIds: string[]) => run('reprint', async () => {
    const state = await perform((token) => reprintToday(itemIds, token));
    setNotice(state.replaced.length ? `Rewritten: ${state.replaced.map((r) => r.to ?? `${r.from} (removed)`).join('; ')}` : undefined);
  });
  const restart = () => run('return', () => perform((token) => returnAndReset(token)));
  const clearance = () => run('clearance', () => perform((token) => recordClinicianClearance(token)));
  const reviewRows = todayLoop?.closePreview.pillarReview ?? [];
  const closedRecord = graph.dayRecords.find((record) => record.closedAt && record.day === todayLoop?.agenda.date);
  const scoreOf = (pillar: string) => pillarScores[pillar] ?? reviewRows.find((row) => row.pillar === pillar)?.score ?? 'miss';
  const submitClose = async () => {
    if (!accessToken || closing || !todayLoop) return;
    setClosing(true); setActionError(undefined);
    try {
      const pillarReview = reviewRows.map((row) => ({ pillar: row.pillar, score: scoreOf(row.pillar), ...(row.completed ? { completed: row.completed } : {}) }));
      await perform((token) => closeToday({
        pillarReview: pillarReview.length ? pillarReview : [{ pillar: 'work', score: 'miss' }],
        ...(!todayLoop.checkedIn ? { verdict: 'miss' as const } : verdictOverride ? { verdict: verdictOverride } : {}),
        ...(closeNote.trim() ? { note: closeNote.trim() } : {}),
        ...(carry.trim() ? { carryForward: carry.trim() } : {}),
      }, token));
    } catch (error) {
      setActionError(plainError(error, 'The day did not close. Try again.'));
    } finally { setClosing(false); }
  };


  return (
    <Screen
      eyebrow="Today"
      title={`${greeting(new Date().getHours())}, ${name}.`}
      subtitle={primaryGoal ? recovery ? 'Recovery Mode is active. Today protects continuity instead of demanding intensity.' : 'APM rebuilt Today from your Personal OS, Life Graph, calendar and current execution state.' : 'APM is ready to build your first durable Personal OS.'}
    >
      {/* Summary first (docs/35 U9): where the day stands, then the ONE next step; the rest is folded below. */}
      <Row wrap gap="xs">
        <Pill tone={recovery ? 'warning' : 'accent'}>{MODE_WORDS[mode] ?? mode.replace('_', ' ')}</Pill>
        {todayPlan ? <Pill>{sentence(todayPlan.completionState.replace('_', ' '))}</Pill> : null}
        {planItemCount ? <Pill>{`${doneCount} of ${planItemCount} done`}</Pill> : null}
      </Row>

      <SaveAccountBanner />

      {!isDurable || (syncStatus === 'error' && !todayLoop) ? (
        <ErrorState title="APM can't reach your account right now." message="Nothing is lost. Check your connection, then try again." onRetry={() => void refresh().catch(() => undefined)} />
      ) : null}

      {graph.personalOS && !loopOpen ? (
        <Card tone="feature">
          <Label tone="accent">Day 1 is ready</Label>
          <Heading>{planCopy.title}</Heading>
          <Body muted>{planCopy.body}</Body>
          <Button label={planCopy.action} large onPress={() => router.push('/settings/plan')} />
        </Card>
      ) : null}

      {modeState?.todayEffect && (mode === 'sprint' || mode === 'deep_work') ? <Card tone="accent"><Label>{mode === 'sprint' ? 'Sprint' : 'Deep Work'}</Label><CardTitle>{modeState.todayEffect.summary}</CardTitle>{modeState.todayEffect.heldBlocks.length ? <Body muted>{modeState.todayEffect.heldBlocks.length} item(s) held {mode === 'sprint' ? 'in maintenance' : 'until the block ends'}.</Body> : null}</Card> : null}

      {recovery ? <Card tone="warning"><Label>Minimum Viable Day</Label><CardTitle>One useful thing. No catch-up debt.</CardTitle><Body muted>Continuity beats intensity today. Completing the smallest critical move is enough.</Body></Card> : null}

      {!graph.personalOS && syncStatus === 'ready' ? (
        <Card tone="feature">
          <Label tone="accent">Start here</Label>
          <Heading>Build your Personal OS so APM can plan around your actual game.</Heading>
          <Button label="Build my APM" large onPress={() => router.push('/intake')} />
        </Card>
      ) : null}

      {todayLoop && graph.personalOS ? (
        <>
          {drifting ? (
            <Card tone="feature">
              <Label tone="accent">Return / Reset</Label>
              <Heading>{todayLoop.drift.message ?? "Welcome back. Want me to print today's agenda and restart the day?"}</Heading>
              <Button label="Yes, restart the day" large onPress={() => void restart()} />
            </Card>
          ) : null}

          {loopOpen && !todayLoop.checkedIn && !todayLoop.closed ? (
            <Card tone="feature">
              <Label tone="accent">{todayLoop.dayStart === 'hard' ? 'Hard Start · opening step' : 'Guided Start · opening step'}</Label>
              <Heading>How is your energy right now, 1 to 10?</Heading>
              <Body muted>{todayLoop.dayStart === 'hard' ? 'Your agenda prints after this answer.' : 'You can read the agenda below; execution starts after this answer.'} At 2 or lower, today becomes a Minimum Viable Day automatically.</Body>
              <ChoiceRow options={Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: String(i + 1) }))} value={mood} onChange={setMood} />
              <Button label={busy ? 'Printing…' : 'Print my agenda'} large disabled={mood === undefined} onPress={() => void checkIn()} />
            </Card>
          ) : null}

          {agenda && !hideAgenda && !phaseOpen && todayLoop.checkedIn && !todayLoop.closed ? (
            <Card tone="feature">
              <Label tone="accent">The first hour</Label>
              <Heading>{agenda.bridge}</Heading>
              {agenda.firstHour.sequence.slice(0, 3).map((step, index) => <Row key={`${index}-${step}`} gap="sm" align="flex-start"><Small tone="inkMuted">{String(index + 1)}</Small><Fill><Body>{step}</Body></Fill></Row>)}
              {agenda.firstHour.sequence.length > 3 ? <Muted>{`${agenda.firstHour.sequence.length - 3} more step(s) in Today's agenda below`}</Muted> : null}
              <Button label="Begin my First Hour" variant="accent" large onPress={() => void beginPhase('first_hour')} />
              <Button label="Coaching first" variant="ghost" onPress={() => router.push('/(tabs)/apm')} />
            </Card>
          ) : null}

          {agenda && !hideAgenda && agenda.firstHour.priority ? itemCard(agenda.firstHour.priority, 'Priority execution') : null}

          {stackOpen && agenda && !hideAgenda && agenda.dailyStack.length ? (
            <>
              <SectionTitle>The daily stack</SectionTitle>
              {agenda.dailyStack.map((item) => itemCard(item))}
            </>
          ) : null}

          {phaseOpen && !stackOpen && agenda?.dailyStack.length && !hideAgenda ? (
            <Card tone="muted"><Body>First Hour first. When it is done, open the rest of the day.</Body><Button label="Open the daily stack" variant="secondary" onPress={() => void beginPhase('executing')} /></Card>
          ) : null}

          {todayLoop.bodyReferral ? (
            <Card tone="danger">
              <Label tone="danger">Body coaching paused</Label>
              <CardTitle>A red flag was recorded. Talk to a doctor before body goals continue.</CardTitle>
              <Body muted>APM never prescribes diet, calories or medication. When a clinician has cleared you, record it here and your body plan restarts.</Body>
              <Button label="A clinician has cleared me" variant="secondary" onPress={() => void clearance()} />
            </Card>
          ) : null}
          {todayLoop.dayState.state === 'missed_yesterday' ? <Card tone="warning"><Label>Never Miss Twice</Label><CardTitle>Yesterday is closed. Today is a Recovery Day.</CardTitle><Body muted>One small thing, then close the day. Nothing from yesterday is owed.</Body></Card> : null}
          {todayLoop.weeklyReview.due ? <Card tone="accent"><Label>{`Weekly debrief · ${todayLoop.weeklyReview.reviewDay}`}</Label><CardTitle>Run your weekly debrief.</CardTitle><Button label="Open the debrief" variant="accent" onPress={() => router.push('/review')} /></Card> : null}

          {gateDue && !hideAgenda && todayLoop.checkedIn ? (
            <Card tone="warning">
              <Label tone="warning">{`${gateDue.label} · ${goalTitleForPlan(gateDue.planId)}`}</Label>
              <CardTitle>{`Recommended: ${gateDue.recommended}. ${gateDue.completedDays} days with evidence.`}</CardTitle>
              <Body muted>Is this goal still aligned with what you want?</Body>
              <Button label="Still aligned" onPress={() => void reviewGate(true)} />
              <Button label="Not aligned any more" variant="secondary" onPress={() => void reviewGate(false)} />
            </Card>
          ) : null}

          {decisionDue && !hideAgenda && todayLoop.checkedIn ? (
            <Card tone="warning">
              <Label tone="warning">Day 90 · forced decision</Label>
              <CardTitle>{`${goalTitleForPlan(decisionDue.planId)}: Promote, Maintain or Park? APM recommends ${decisionDue.recommended}.`}</CardTitle>
              {decisionDue.criteria.map((line) => <Body key={line} muted>{line}</Body>)}
              <ChoiceRow options={[{ id: 'promote', label: 'Promote' }, { id: 'maintain', label: 'Maintain' }, { id: 'park', label: 'Park' }]} value={chosenDecision} onChange={setDecision} />
              <TextField value={decisionReason} onChangeText={setDecisionReason} placeholder="Why (optional)" />
              <Button label="Record the decision" onPress={() => void decide()} />
              <Body muted>Parking is a successful outcome: it is a strategic allocation choice.</Body>
            </Card>
          ) : null}

          <Toast message={notice} />
          {actionError ? <ErrorState message={actionError} /> : null}

          {!hideAgenda && !recovery && approvals.length ? (
            <>
              <SectionTitle>Needs your approval</SectionTitle>
              {approvals.map((action) => <Card key={action.id} tone="warning"><Label tone="warning">{action.domain} · {action.actionType}</Label><CardTitle>{action.reason}</CardTitle><Body muted>APM prepared this action but has not executed it. Your subscription does not grant permission; this approval is explicit.</Body><Button label={busyActionId === action.id ? 'Executing…' : 'Approve & execute'} onPress={() => void approve(action.id)} /></Card>)}
            </>
          ) : null}

          <BedRoutineToday graph={graph} />

          {!hideAgenda && !recovery ? (
            <>
              <SectionTitle>Your run of show</SectionTitle>
              <RunOfShow blocks={todayPlan?.blocks ?? []} sourceLabel={(block) => (block.source === 'calendar' ? sourceAccountLabel(graph.connections, 'calendar', block.connectionIds) : undefined)} />
            </>
          ) : null}

          <CoachingModeChips graph={graph} activeMode={mode} />

          {agenda && !hideAgenda ? (
            <Disclosure icon="list" title="Today's agenda" summary={`${agenda.foregroundPriority?.label ?? 'No foreground goal yet'} · ${agenda.dailyStack.length} in the daily stack`}>
              <Label>Foreground priority</Label>
              <CardTitle>{agenda.foregroundPriority?.label ?? 'No foreground goal yet'}</CardTitle>
              <Row wrap gap="xs">
                <Pill tone={agenda.mode === 'recovery' ? 'warning' : 'neutral'}>{agenda.mode === 'recovery' ? 'Minimum Viable Day' : 'Standard day'}</Pill>
                {agenda.dayIndex ? <Pill>{`Day ${Math.max(agenda.dayIndex, 0)} of 90`}</Pill> : null}
                <Pill>{todayLoop.locked ? 'Set for today' : 'Draft until your check-in'}</Pill>
              </Row>
              {agenda.background.length ? <Body muted>{`Background (maintenance only): ${agenda.background.map((b) => b.label).join(', ')}`}</Body> : null}
              {agenda.firstHour.sequence.length ? (
                <Card tone="accent"><Label>The first hour</Label>{agenda.firstHour.sequence.map((step, index) => <KeyValue key={`${index}-${step}`} label={`${index + 1}`} value={step} />)}</Card>
              ) : null}
              {agenda.firstHour.priority ? null : <Body>No foreground action is available. Add a goal in Goals.</Body>}
              {!todayLoop.checkedIn && agenda.dailyStack.length ? <Label>The daily stack</Label> : null}
              {!todayLoop.checkedIn ? agenda.dailyStack.map((item) => itemCard(item)) : null}
              {(agenda.trackFlags ?? []).length ? <Card tone="warning"><Label>Your Tracks</Label>{(agenda.trackFlags ?? []).map((flag) => <Body key={`${flag.code}-${flag.message}`}>{`• ${flag.message}`}</Body>)}</Card> : null}
              {agenda.safety.referral ? <Card tone="danger"><Label tone="danger">Body coaching paused</Label><Body>{agenda.safety.doctorLine ?? 'Talk to a clinician before body goals continue.'}</Body></Card> : null}
              <LinkButton label="Something to file without coaching? Open the Diary" onPress={() => router.push('/diary')} />
            </Disclosure>
          ) : null}

          {agenda && !hideAgenda && agenda.problems.length ? <Card tone="warning"><Label tone="warning">Today's plan needs a fix</Label>{agenda.problems.map((problem) => <Body key={problem}>{problem}</Body>)}{todayLoop.locked ? <Button label="Rewrite today's plan" onPress={() => void reprint([])} /> : null}</Card> : null}

          <Disclosure icon="layers" title="More for today" summary="Your first week, quick taps, practices, what APM noticed, open loops">
            {todayLoop.firstWeek ? (
              <Card>
                <Label>{`First 7 days · Day ${todayLoop.firstWeek.day}: ${todayLoop.firstWeek.objective}`}</Label>
                <CardTitle>{`Success = ${todayLoop.firstWeek.success}`}</CardTitle>
                <Body>{todayLoop.firstWeek.loop}</Body>
                {todayLoop.firstWeek.rules.map((rule) => <Body key={rule} muted>{`• ${rule}`}</Body>)}
              </Card>
            ) : null}
            <QuickTaps graph={graph} />
            <PracticesToday graph={graph} />
            {todayLoop.coachingCheckIn.due ? <Card tone="muted"><Label>Coaching check-in</Label><Body>{todayLoop.coachingCheckIn.message}</Body><Button label="Open APM Coach" variant="secondary" onPress={() => router.push('/(tabs)/apm')} /></Card> : null}
            {hideAgenda ? <Body muted>Hard Start: Radar, your run of show, approvals and the close appear after the opening step.</Body> : null}
            {!hideAgenda && completionEvidence ? <Card><Label>Evidence recorded</Label><CardTitle>{completionEvidence.summary}</CardTitle><KeyValue label="Source" value="You marked it complete" /><KeyValue label="Recorded" value={new Date(completionEvidence.createdAt).toLocaleString()} /></Card> : null}
            {!hideAgenda && !recovery ? (
              <>
                <Label>APM noticed</Label>
                {firstRadarItem ? <Card tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'default'}><Pill tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'neutral'}>{firstRadarItem.type} · {firstRadarItem.severity}</Pill><CardTitle>{firstRadarItem.headline}</CardTitle><Body muted>{firstRadarItem.summary}</Body><Button label="Why am I seeing this?" variant="secondary" onPress={() => router.push({ pathname: '/radar/why', params: { id: firstRadarItem.id } })} /></Card> : <EmptyState icon="compass" title="Radar is clear for now." body="APM found no high-value signal it can justify surfacing right now." />}
                <Label>Open loops</Label>
                <Row wrap gap="xs">
                  <Pill>{`${todayPlan?.commitmentIds.length ?? 0} commitments`}</Pill>
                  <Pill>{`${todayPlan?.routineIds.length ?? 0} routines`}</Pill>
                  <Pill>{`${todayPlan?.radarItemIds.length ?? 0} Radar items`}</Pill>
                </Row>
              </>
            ) : null}
            {!hideAgenda && recovery ? <Body muted>Minimum Viable Day: the run of show, approvals and open loops wait until tomorrow. One thing, then close.</Body> : null}
            {graph.personalOS ? <Card tone="muted"><Label>Personal OS</Label><KeyValue label="Day start" value={graph.personalOS.accountability.dayStart === 'hard' ? 'Hard Start' : 'Guided Start'} /><KeyValue label="Tracks" value={graph.tracks.filter((track) => track.active).map((track) => track.name).join(', ') || 'None'} /></Card> : null}
            {todayLoop.locked && !todayLoop.closed ? (
              <>
                <Label>Something changed?</Label>
                <Body muted>The morning plan stands. Only a real external change, a safety issue or a permission change reopens it.</Body>
                <ChoiceRow<ReplanReason> options={[{ id: 'external_change', label: 'External change' }, { id: 'safety', label: 'Safety / sick' }, { id: 'permission', label: 'Permission changed' }, { id: 'mood', label: 'I feel tired' }]} onChange={(reason) => void replan(reason)} />
              </>
            ) : null}
          </Disclosure>
        </>
      ) : null}

      {!(todayLoop && graph.personalOS) && actionError ? <ErrorState message={actionError} /> : null}

      {hideAgenda ? null : (
        <>
          {todayLoop?.closed ? (
            <Card tone="accent">
              <Label tone="accent">Day closed</Label>
              <Heading>{todayLoop.day?.verdict === 'full_day' ? '✅ Full Day' : todayLoop.day?.verdict === 'mvd' ? '⚡ Minimum Viable Day' : '❌ Miss: it is data, not a verdict on you'}</Heading>
              {closedRecord?.pillarReview?.length ? <PillarRollUpLine graph={graph} review={closedRecord.pillarReview} recovery={closedRecord.mode === 'recovery'} /> : null}
              {todayLoop.day?.insight ? <Body>{todayLoop.day.insight}</Body> : null}
              {todayLoop.day?.carryForward ? <KeyValue label="Carrying to tomorrow" value={todayLoop.day.carryForward} /> : null}
            </Card>
          ) : todayLoop && loopOpen ? (
            <Disclosure icon="moon" title="Close the day" summary="Score each area, then close. Nothing becomes debt for tomorrow.">
              <Body muted>What did you complete today? Score each area; the line below rolls them up to Mind, Body and Spirit. Closing records evidence for continuity; nothing becomes debt for tomorrow.</Body>
              {todayLoop.closePreview.evidence.length ? <><Label>Completion evidence</Label>{todayLoop.closePreview.evidence.map((line) => <Body key={line}>{`• ${line}`}</Body>)}</> : <Body muted>No completion evidence yet today.</Body>}
              {reviewRows.map((row) => (
                <Stack key={row.pillar} gap="xs">
                  <Label>{areaDisplay(row.pillar)}</Label>
                  <ChoiceRow options={[{ id: 'hit', label: '✅ Hit' }, { id: 'partial', label: '⚡ Partial' }, { id: 'miss', label: '❌ Missed' }]} value={scoreOf(row.pillar)} onChange={(score) => setPillarScores((current) => ({ ...current, [row.pillar]: score }))} />
                </Stack>
              ))}
              {reviewRows.length ? <PillarRollUpLine graph={graph} review={reviewRows.map((row) => ({ ...row, score: scoreOf(row.pillar) }))} recovery={recovery} /> : null}
              <KeyValue label="APM's verdict from the evidence" value={VERDICT_WORDS[todayLoop.closePreview.computedVerdict] ?? todayLoop.closePreview.computedVerdict.replace('_', ' ')} />
              {todayLoop.checkedIn ? (
                <>
                  <Label>Your verdict (optional: you have the final say)</Label>
                  <ChoiceRow
                    options={[
                      ...(planItemCount > 0 && doneCount === planItemCount && agenda?.mode !== 'recovery' ? [{ id: 'full_day' as const, label: 'Full Day' }] : []),
                      ...(doneCount > 0 ? [{ id: 'mvd' as const, label: 'MVD' }] : []),
                      { id: 'miss' as const, label: 'Miss' },
                    ]}
                    value={verdictOverride}
                    onChange={setVerdictOverride}
                  />
                  <Body muted>{`The verdict can't claim more than the evidence: ${doneCount} of ${planItemCount} agenda items done.`}</Body>
                </>
              ) : <Body muted>No check-in today, so the day closes as a Miss. A miss is data: tomorrow starts as a Recovery Day.</Body>}
              <TextField value={closeNote} onChangeText={setCloseNote} placeholder="A note for today (optional)" multiline />
              <TextField label="One item to carry to tomorrow (optional)" value={carry} onChangeText={setCarry} placeholder="e.g. Book the gym induction for Thursday" />
              <Button label={closing ? 'Closing…' : 'Close the day'} onPress={() => void submitClose()} />
            </Disclosure>
          ) : null}
          {todayLoop?.showContinuity && todayLoop.continuity.length ? (
            <Card tone="muted"><Label>Last 7 days</Label><Heading>{todayLoop.continuity.map((day) => day.symbol).join('  ')}</Heading><Muted>✅ Full Day · ⚡ MVD · ❌ Miss · · not closed</Muted></Card>
          ) : null}
        </>
      )}

      <SectionTitle>Trust & control</SectionTitle>
      <ListRow icon="shield" title="Privacy & AI" detail="See exactly how APM works with your information: data, AI processing, providers, connections, permissions and activity." onPress={() => router.push('/settings/privacy')} />
      <ListRow icon="settings" title="Settings" onPress={() => router.push('/settings')} />
    </Screen>
  );
}

const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const MODE_WORDS: Record<string, string> = { standard: 'Standard', high_pressure: 'High-Pressure', executive_review: 'Executive Review', sprint: 'Sprint', recovery: 'Recovery', deep_work: 'Deep Work' };
const VERDICT_WORDS: Record<string, string> = { full_day: 'Full Day', mvd: 'Minimum Viable Day', miss: 'Miss' };
const ITEM_KIND_WORDS: Record<AgendaItem['kind'], string> = { plan_action: 'Plan step', plan_floor: 'Floor', next_action: 'Next action', track_floor: 'Track floor', carry_forward: 'Carried over' };

/** C's run of show: a hairline list, time on the left; the first three, the rest one tap away. */
function RunOfShow({ blocks, sourceLabel }: { blocks: NonNullable<ReturnType<typeof useLifeGraph>['todayPlan']>['blocks']; sourceLabel: (block: NonNullable<ReturnType<typeof useLifeGraph>['todayPlan']>['blocks'][number]) => string | undefined }) {
  const [all, setAll] = useState(false);
  if (!blocks.length) return <EmptyState icon="calendar" title="Nothing scheduled yet" body="No calendar or execution blocks are available yet." />;
  const shown = all ? blocks : blocks.slice(0, 3);
  return (
    <Card>
      {shown.map((block, index) => (
        <Stack key={block.id} gap="xxs">
          {index ? <Divider /> : null}
          <Row gap="sm" align="flex-start">
            <Small tone={index === 0 ? 'accent' : 'inkMuted'} strong={index === 0}>{block.startAt ? `${timeLabel(block.startAt) ?? ''}${block.endAt ? `–${timeLabel(block.endAt)}` : ''}` : 'Any time'}</Small>
            <Fill>
              <Body strong={index === 0}>{block.title}</Body>
              <Muted>{[block.source === 'calendar' ? 'Calendar' : 'Plan', sourceLabel(block)].filter(Boolean).join(' · ')}</Muted>
            </Fill>
          </Row>
        </Stack>
      ))}
      {blocks.length > 3 ? <LinkButton label={all ? 'Show less' : `Show all ${blocks.length}`} onPress={() => setAll((v) => !v)} /> : null}
    </Card>
  );
}
