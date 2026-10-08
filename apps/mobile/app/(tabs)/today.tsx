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
  Icon,
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
  type IconName,
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
import { appDistribution, billingAvailability } from '../../src/billing/purchases';
import { webCheckoutAllowed } from '../../src/billing/distribution';
import { plainError } from '../../src/api/errors';
import { greeting } from '../../src/content/greeting';
import { GATE_WORDS, ITEM_KIND_WORDS, MODE_WORDS, TODAY_COPY, VERDICT_WORDS, actionTag, radarTag, shortDate } from '../../src/content/words';

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
  // Which agenda item is saving: only THAT card says "Recording…" (docs/35 E22).
  const [busyItemId, setBusyItemId] = useState<string>();
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
    setBusyItemId(item.id);
    try {
      if (item.planId && item.actionKey) await perform((token) => completeAgendaAction({ planId: item.planId!, actionKey: item.actionKey! }, token));
      else if (item.nextActionId) await completeNextAction(item.nextActionId);
    } finally { setBusyItemId(undefined); }
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
  // Web app and sideload APK pay by card here: never told to use a store app.
  const planCopy = noPlanCopy(billingAvailability().available || webCheckoutAllowed(appDistribution()));

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
      {item.status === 'open' && executionOpen && phaseOpen ? <Button label={busyItemId === item.id ? 'Recording…' : 'Mark done'} busy={busyItemId === item.id} disabled={busy && busyItemId !== item.id} onPress={() => completeItem(item)} /> : null}
      {item.status === 'open' && executionOpen && phaseOpen && todayLoop?.locked ? <Button label="Can't do this as written? Rewrite it" variant="ghost" onPress={() => reprint([item.id])} /> : null}
      {item.status === 'open' && !executionOpen && !todayLoop?.closed ? <Body muted>{TODAY_COPY.afterCheckIn}</Body> : null}
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
  // Open loops as words, and only the non-zero ones ("0 commitments · 0 routines" said nothing).
  const openLoops = [
    [todayPlan?.commitmentIds.length ?? 0, 'promise', 'promises'],
    [todayPlan?.routineIds.length ?? 0, 'routine', 'routines'],
    [todayPlan?.radarItemIds.length ?? 0, 'heads-up', 'heads-ups'],
  ].filter(([n]) => Number(n) > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
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
      subtitle={primaryGoal ? recovery ? TODAY_COPY.subtitleRecovery : TODAY_COPY.subtitle : TODAY_COPY.subtitleNoOs}
    >
      {/* Summary first (docs/35 U9): where the day stands, then the ONE next step; the rest is folded below. */}
      {/* Only what tells her something: a non-standard mode and the done count. "Standard" and
          "Not started" said nothing (docs/36 T5). */}
      {mode !== 'standard' || planItemCount ? (
        <Row wrap gap="xs">
          {mode !== 'standard' ? <Pill tone={recovery ? 'warning' : 'accent'}>{`${MODE_WORDS[mode] ?? 'Coaching'} mode`}</Pill> : null}
          {planItemCount ? <Pill tone={doneCount && doneCount === planItemCount ? 'success' : 'neutral'}>{`${doneCount} of ${planItemCount} done`}</Pill> : null}
        </Row>
      ) : null}

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
          <Heading>{TODAY_COPY.noOsTitle}</Heading>
          <Button label={TODAY_COPY.noOsButton} large onPress={() => router.push('/intake')} />
        </Card>
      ) : null}

      {todayLoop && graph.personalOS ? (
        <>
          {drifting ? (
            <Card tone="feature">
              <Label tone="accent">Welcome back</Label>
              <Heading>{todayLoop.drift.message ?? TODAY_COPY.drift}</Heading>
              <Button label="Yes, restart the day" large onPress={() => restart()} />
            </Card>
          ) : null}

          {loopOpen && !todayLoop.checkedIn && !todayLoop.closed ? (
            <Card tone="feature">
              <Label tone="accent">{TODAY_COPY.checkInLabel}</Label>
              <Heading>{TODAY_COPY.checkInQuestion}</Heading>
              <Body muted>{todayLoop.dayStart === 'hard' ? TODAY_COPY.checkInBodyHard : TODAY_COPY.checkInBody}</Body>
              <ChoiceRow options={Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: String(i + 1) }))} value={mood} onChange={setMood} />
              <Button label={busy ? TODAY_COPY.checkInBusy : TODAY_COPY.checkInButton} large busy={busy} disabled={mood === undefined} disabledReason={TODAY_COPY.checkInReason} onPress={() => checkIn() || undefined} />
            </Card>
          ) : null}

          {agenda && !hideAgenda && !phaseOpen && todayLoop.checkedIn && !todayLoop.closed ? (
            <Card tone="feature">
              <Label tone="accent">The first hour</Label>
              <Heading>{agenda.bridge}</Heading>
              {agenda.firstHour.sequence.slice(0, 3).map((step, index) => <Row key={`${index}-${step}`} gap="sm" align="flex-start"><Small tone="inkMuted">{String(index + 1)}</Small><Fill><Body>{step}</Body></Fill></Row>)}
              {agenda.firstHour.sequence.length > 3 ? <Muted>{`${agenda.firstHour.sequence.length - 3} more step(s) in Today's agenda below`}</Muted> : null}
              <Button label="Begin my First Hour" variant="accent" large onPress={() => beginPhase('first_hour')} />
              <Button label="Coaching first" variant="ghost" onPress={() => router.push('/(tabs)/apm')} />
            </Card>
          ) : null}

          {agenda && !hideAgenda && agenda.firstHour.priority ? itemCard(agenda.firstHour.priority, TODAY_COPY.priorityLabel) : null}

          {stackOpen && agenda && !hideAgenda && agenda.dailyStack.length ? (
            <>
              <SectionTitle>The rest of today</SectionTitle>
              {agenda.dailyStack.map((item) => itemCard(item))}
            </>
          ) : null}

          {phaseOpen && !stackOpen && agenda?.dailyStack.length && !hideAgenda ? (
            <Card tone="muted"><Body>First Hour first. When it is done, open the rest of the day.</Body><Button label="Open the rest of today" variant="secondary" onPress={() => beginPhase('executing')} /></Card>
          ) : null}

          {todayLoop.bodyReferral ? (
            <Card tone="danger">
              <Label tone="danger">Body coaching paused</Label>
              <CardTitle>A red flag was recorded. Talk to a doctor before body goals continue.</CardTitle>
              <Body muted>APM never prescribes diet, calories or medication. When a clinician has cleared you, record it here and your body plan restarts.</Body>
              <Button label="A clinician has cleared me" variant="secondary" onPress={() => clearance()} />
            </Card>
          ) : null}
          {todayLoop.dayState.state === 'missed_yesterday' ? <Card tone="warning"><Label>Never Miss Twice</Label><CardTitle>Yesterday is closed. Today is a Recovery Day.</CardTitle><Body muted>One small thing, then close the day. Nothing from yesterday is owed.</Body></Card> : null}
          {todayLoop.weeklyReview.due ? <Card tone="accent"><Label>{`Weekly debrief · ${todayLoop.weeklyReview.reviewDay}`}</Label><CardTitle>Run your weekly debrief.</CardTitle><Button label="Open the debrief" variant="accent" onPress={() => router.push('/review')} /></Card> : null}

          {gateDue && !hideAgenda && todayLoop.checkedIn ? (
            <Card tone="warning">
              <Label tone="warning">{`${gateDue.label} · ${goalTitleForPlan(gateDue.planId)}`}</Label>
              <CardTitle>{`APM suggests you ${GATE_WORDS[gateDue.recommended] ?? 'keep going'}. You showed up on ${gateDue.completedDays} days.`}</CardTitle>
              <Body muted>Is this goal still aligned with what you want?</Body>
              <Button label="Still aligned" onPress={() => void reviewGate(true)} />
              <Button label="Not aligned any more" variant="secondary" onPress={() => void reviewGate(false)} />
            </Card>
          ) : null}

          {decisionDue && !hideAgenda && todayLoop.checkedIn ? (
            <Card tone="warning">
              <Label tone="warning">Day 90 · time to decide</Label>
              <CardTitle>{`${goalTitleForPlan(decisionDue.planId)}: APM suggests you ${GATE_WORDS[decisionDue.recommended] ?? 'keep going'}.`}</CardTitle>
              {decisionDue.criteria.map((line) => <Body key={line} muted>{line}</Body>)}
              <ChoiceRow options={[{ id: 'promote', label: 'Make it my main goal' }, { id: 'maintain', label: 'Keep it as it is' }, { id: 'park', label: 'Park it' }]} value={chosenDecision} onChange={setDecision} />
              <TextField value={decisionReason} onChangeText={setDecisionReason} placeholder="Why (optional)" />
              <Button label="Save my decision" onPress={() => decide() || undefined} />
              <Body muted>Parking a goal is a good outcome: it frees energy for what matters now.</Body>
            </Card>
          ) : null}

          <Toast message={notice} />
          {actionError ? <ErrorState message={actionError} /> : null}

          {!hideAgenda && !recovery && approvals.length ? (
            <>
              <SectionTitle>Needs your approval</SectionTitle>
              {approvals.map((action) => <Card key={action.id} tone="warning"><Label tone="warning">{actionTag(action.domain, action.actionType)}</Label><CardTitle>{action.reason}</CardTitle><Body muted>{TODAY_COPY.approvalBody}</Body><Button label={busyActionId === action.id ? TODAY_COPY.approvalBusy : TODAY_COPY.approvalButton} busy={busyActionId === action.id} disabled={Boolean(busyActionId) && busyActionId !== action.id} onPress={() => approve(action.id)} /></Card>)}
            </>
          ) : null}

          <BedRoutineToday graph={graph} />

          {!hideAgenda && !recovery ? (
            <>
              <SectionTitle>Your schedule</SectionTitle>
              <RunOfShow blocks={todayPlan?.blocks ?? []} sourceLabel={(block) => (block.source === 'calendar' ? sourceAccountLabel(graph.connections, 'calendar', block.connectionIds) : undefined)} />
            </>
          ) : null}

          <CoachingModeChips graph={graph} activeMode={mode} />

          {agenda && !hideAgenda ? (
            <Disclosure icon="list" title="Today's agenda" summary={`${agenda.foregroundPriority?.label ?? 'Your main goal'}${agenda.dailyStack.length ? ` · ${agenda.dailyStack.length} more for today` : ''}`}>
              <Label>Your main goal</Label>
              <CardTitle>{agenda.foregroundPriority?.label ?? 'No main goal yet'}</CardTitle>
              <Row wrap gap="xs">
                <Pill tone={agenda.mode === 'recovery' ? 'warning' : 'neutral'}>{agenda.mode === 'recovery' ? 'Light day' : 'Full day'}</Pill>
                {agenda.dayIndex ? <Pill>{`Day ${Math.max(agenda.dayIndex, 0)} of 90`}</Pill> : null}
                <Pill>{todayLoop.locked ? 'Set for today' : 'Draft until your check-in'}</Pill>
              </Row>
              {agenda.background.length ? <Body muted>{`Kept ticking over: ${agenda.background.map((b) => b.label).join(', ')}`}</Body> : null}
              {agenda.firstHour.sequence.length ? (
                <Card tone="accent"><Label>The first hour</Label>{agenda.firstHour.sequence.map((step, index) => <KeyValue key={`${index}-${step}`} label={`${index + 1}`} value={step} />)}</Card>
              ) : null}
              {agenda.firstHour.priority ? null : <Body>No step toward a goal today. Add a goal in Goals and APM plans it.</Body>}
              {!todayLoop.checkedIn && agenda.dailyStack.length ? <Label>The rest of today</Label> : null}
              {!todayLoop.checkedIn ? agenda.dailyStack.map((item) => itemCard(item)) : null}
              {(agenda.trackFlags ?? []).length ? <Card tone="warning"><Label>Your Tracks</Label>{(agenda.trackFlags ?? []).map((flag) => <Body key={`${flag.code}-${flag.message}`}>{`• ${flag.message}`}</Body>)}</Card> : null}
              {agenda.safety.referral ? <Card tone="danger"><Label tone="danger">Body coaching paused</Label><Body>{agenda.safety.doctorLine ?? 'Talk to a clinician before body goals continue.'}</Body></Card> : null}
              <LinkButton label="Something to file without coaching? Open the Diary" onPress={() => router.push('/diary')} />
            </Disclosure>
          ) : null}

          {agenda && !hideAgenda && agenda.problems.length ? <Card tone="warning"><Label tone="warning">Today's plan needs a fix</Label>{agenda.problems.map((problem) => <Body key={problem}>{problem}</Body>)}{todayLoop.locked ? <Button label="Rewrite today's plan" onPress={() => reprint([])} /> : null}</Card> : null}

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
            {hideAgenda ? <Body muted>The rest of today appears after you answer the energy question.</Body> : null}
            {!hideAgenda && completionEvidence ? <Card><Label>Evidence recorded</Label><CardTitle>{completionEvidence.summary}</CardTitle><KeyValue label="Source" value="You marked it complete" /><KeyValue label="Recorded" value={new Date(completionEvidence.createdAt).toLocaleString()} /></Card> : null}
            {!hideAgenda && !recovery ? (
              <>
                <Label>APM noticed</Label>
                {firstRadarItem ? <Card tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'default'}><Pill tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'neutral'}>{radarTag(firstRadarItem.type, firstRadarItem.severity)}</Pill><CardTitle>{firstRadarItem.headline}</CardTitle><Body muted>{firstRadarItem.summary}</Body><Button label="Why am I seeing this?" variant="secondary" onPress={() => router.push({ pathname: '/radar/why', params: { id: firstRadarItem.id } })} /></Card> : <EmptyState icon="compass" title="Nothing slipping right now." body="APM tells you here when a promise, deadline or reply needs you." />}
                {openLoops.length ? (
                  <>
                    <Label>Open loops</Label>
                    <Row wrap gap="xs">{openLoops.map((loop) => <Pill key={loop}>{loop}</Pill>)}</Row>
                  </>
                ) : null}
              </>
            ) : null}
            {!hideAgenda && recovery ? <Body muted>Light day: your schedule, approvals and open loops wait until tomorrow. One thing, then close.</Body> : null}
            {graph.tracks.some((track) => track.active) ? <Card tone="muted"><Label>Running in the background</Label><Body>{graph.tracks.filter((track) => track.active).map((track) => track.name).join(', ')}</Body></Card> : null}
            {todayLoop.locked && !todayLoop.closed ? (
              <>
                <Label>Something changed?</Label>
                <Body muted>The morning plan stands, so you don't renegotiate it at 2 p.m. Tap one only if something real changed; APM rewrites the rest of today.</Body>
                <ChoiceRow<ReplanReason> options={[{ id: 'external_change', label: 'My day changed' }, { id: 'safety', label: "I'm sick or not safe" }, { id: 'permission', label: 'An app access changed' }, { id: 'mood', label: "I'm worn out" }]} onChange={(reason) => void replan(reason)} />
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
              <Heading>{todayLoop.day?.verdict === 'full_day' ? 'Full day. Well done.' : todayLoop.day?.verdict === 'mvd' ? 'Light day. It counts.' : 'Missed. It is data, not a verdict on you.'}</Heading>
              {closedRecord?.pillarReview?.length ? <PillarRollUpLine graph={graph} review={closedRecord.pillarReview} recovery={closedRecord.mode === 'recovery'} /> : null}
              {todayLoop.day?.insight ? <Body>{todayLoop.day.insight}</Body> : null}
              {todayLoop.day?.carryForward ? <KeyValue label="Carrying to tomorrow" value={todayLoop.day.carryForward} /> : null}
            </Card>
          ) : todayLoop && loopOpen ? (
            <Disclosure icon="moon" title="Close the day" summary="Two taps. Nothing carries over as debt.">
              <Body muted>APM already filled this in from what you marked done. Change anything that's wrong, then close.</Body>
              {todayLoop.closePreview.evidence.length ? <><Label>Done today</Label>{todayLoop.closePreview.evidence.map((line) => <Body key={line}>{`• ${line}`}</Body>)}</> : <Body muted>Nothing marked done yet today.</Body>}
              {reviewRows.map((row) => (
                <Stack key={row.pillar} gap="xs">
                  <Label>{areaDisplay(row.pillar)}</Label>
                  <ChoiceRow options={[{ id: 'hit', label: 'Done' }, { id: 'partial', label: 'Partly' }, { id: 'miss', label: 'Missed' }]} value={scoreOf(row.pillar)} onChange={(score) => setPillarScores((current) => ({ ...current, [row.pillar]: score }))} />
                </Stack>
              ))}
              {reviewRows.length ? <PillarRollUpLine graph={graph} review={reviewRows.map((row) => ({ ...row, score: scoreOf(row.pillar) }))} recovery={recovery} /> : null}
              <KeyValue label="How APM scores today" value={VERDICT_WORDS[todayLoop.closePreview.computedVerdict] ?? 'Missed'} />
              {todayLoop.checkedIn ? (
                <>
                  <Label>Your call (optional: you have the final say)</Label>
                  <ChoiceRow
                    options={[
                      ...(planItemCount > 0 && doneCount === planItemCount && agenda?.mode !== 'recovery' ? [{ id: 'full_day' as const, label: 'Full day' }] : []),
                      ...(doneCount > 0 ? [{ id: 'mvd' as const, label: 'Light day' }] : []),
                      { id: 'miss' as const, label: 'Missed' },
                    ]}
                    value={verdictOverride}
                    onChange={setVerdictOverride}
                  />
                  <Body muted>{`You marked ${doneCount} of ${planItemCount} things done today.`}</Body>
                </>
              ) : <Body muted>No energy check today, so the day closes as missed. That's fine: tomorrow starts as a light day.</Body>}
              <TextField value={closeNote} onChangeText={setCloseNote} placeholder="A note for today (optional)" multiline />
              <TextField label="One item to carry to tomorrow (optional)" value={carry} onChangeText={setCarry} placeholder="e.g. Book the gym induction for Thursday" />
              <Button label={closing ? 'Closing…' : 'Close the day'} busy={closing} onPress={() => submitClose()} />
            </Disclosure>
          ) : null}
          {todayLoop?.showContinuity && todayLoop.continuity.length ? (
            <ContinuityStrip days={todayLoop.continuity} />
          ) : null}
        </>
      )}

      <SectionTitle>Trust & control</SectionTitle>
      <ListRow icon="shield" title="Privacy & AI" detail="What APM knows, how AI is used, and what APM may do." onPress={() => router.push('/settings/privacy')} />
      <ListRow icon="settings" title="Settings" onPress={() => router.push('/settings')} />
    </Screen>
  );
}

/** The last 7 days as seven labelled dots (one icon set, no emoji; docs/36 T16). */
function ContinuityStrip({ days }: { days: ReadonlyArray<{ day: string; verdict?: 'full_day' | 'mvd' | 'miss' }> }) {
  const icon = (v?: string): IconName => (v === 'full_day' ? 'check-circle' : v === 'mvd' ? 'zap' : v === 'miss' ? 'x-circle' : 'circle');
  const tone = (v?: string) => (v === 'full_day' ? 'success' as const : v === 'mvd' ? 'accent' as const : v === 'miss' ? 'danger' as const : 'inkMuted' as const);
  return (
    <Card tone="muted">
      <Label>Last 7 days</Label>
      <Row gap="sm" wrap>
        {days.map((d) => <Icon key={d.day} name={icon(d.verdict)} size={22} tone={tone(d.verdict)} label={`${shortDate(d.day)}: ${d.verdict ? VERDICT_WORDS[d.verdict] : 'not closed'}`} />)}
      </Row>
      <Row gap="sm" wrap>
        <Row gap="xxs"><Icon name="check-circle" size={14} tone="success" /><Small tone="inkMuted">Full day</Small></Row>
        <Row gap="xxs"><Icon name="zap" size={14} tone="accent" /><Small tone="inkMuted">Light day</Small></Row>
        <Row gap="xxs"><Icon name="x-circle" size={14} tone="danger" /><Small tone="inkMuted">Missed</Small></Row>
        <Row gap="xxs"><Icon name="circle" size={14} tone="inkMuted" /><Small tone="inkMuted">Not closed</Small></Row>
      </Row>
    </Card>
  );
}

/** C's run of show: a hairline list, time on the left; the first three, the rest one tap away. */
function RunOfShow({ blocks, sourceLabel }: { blocks: NonNullable<ReturnType<typeof useLifeGraph>['todayPlan']>['blocks']; sourceLabel: (block: NonNullable<ReturnType<typeof useLifeGraph>['todayPlan']>['blocks'][number]) => string | undefined }) {
  const [all, setAll] = useState(false);
  if (!blocks.length) return <EmptyState icon="calendar" title="Nothing scheduled yet" body={TODAY_COPY.runOfShowEmpty} actionLabel={TODAY_COPY.runOfShowEmptyAction} onAction={() => router.push('/settings/privacy/connections')} />;
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
              <Muted>{[block.source === 'calendar' ? 'Calendar' : 'From your plan', sourceLabel(block)].filter(Boolean).join(' · ')}</Muted>
            </Fill>
          </Row>
        </Stack>
      ))}
      {blocks.length > 3 ? <LinkButton label={all ? 'Show less' : `Show all ${blocks.length}`} onPress={() => setAll((v) => !v)} /> : null}
    </Card>
  );
}
