import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Label,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';
import { approveExternalAction, closeDay } from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { useSession } from '../../src/state/session';

function timeLabel(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function TodayScreen() {
  const { graph, todayPlan, completeNextAction, isDurable, syncError, refresh } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const primaryAction = todayPlan?.numberOneMove;
  const completionEvidence = graph.evidence.find((item) => item.relatedActionId === primaryAction?.id);
  const firstRadarItem = graph.radarItems[0];
  const name = graph.identity.displayName || 'there';
  const mode = todayPlan?.mode ?? graph.personalOS?.activeMode ?? 'standard';
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
      await closeDay(verdict, undefined, accessToken);
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

      {recovery ? <Card tone="warning"><Label>Minimum Viable Day</Label><CardTitle>One useful thing. No catch-up debt.</CardTitle><Body muted>Continuity beats intensity today. Completing the smallest critical move is enough.</Body></Card> : null}

      {(todayPlan?.morningSequence.length ?? 0) > 0 ? (
        <>
          <SectionTitle>First hour</SectionTitle>
          <Card tone="accent">
            <Label>Your launch sequence</Label>
            {todayPlan!.morningSequence.map((step, index) => <KeyValue key={`${index}-${step}`} label={`${index + 1}`} value={step} />)}
          </Card>
        </>
      ) : null}

      <Card tone="accent">
        <Label>{recovery ? 'Your MVD move' : 'Your #1 move'}</Label>
        <CardTitle>{primaryAction?.title ?? primaryGoal?.title ?? 'Finish your APM onboarding'}</CardTitle>
        <Body muted>{primaryGoal ? `Primary pillar: ${primaryGoal.pillar ?? 'not set'}. APM chooses an executable move from durable Personal OS + Life Graph state.` : 'Build your Personal OS so APM can start planning around your actual game.'}</Body>
        <View style={uiStyles.row}><Pill tone="success">Life Graph</Pill><Pill>{primaryAction?.estimatedMinutes ? `${primaryAction.estimatedMinutes} min` : 'Setup'}</Pill></View>
        {!primaryGoal ? <Button label="Build my APM" onPress={() => router.push('/onboarding')} /> : primaryAction ? <Button label={busy ? 'Recording…' : recovery ? 'Complete my MVD move' : 'Mark #1 move complete'} onPress={() => void complete()} /> : <Body>There is no open next action. Radar will flag the missing execution path.</Body>}
      </Card>

      {actionError ? <Card tone="danger"><Body>{actionError}</Body></Card> : null}

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
        <Button label={closing ? 'Saving…' : 'Full Day'} onPress={() => void closeToday('full_day')} />
        <Button label="Minimum Viable Day" variant="secondary" onPress={() => void closeToday('mvd')} />
        <Button label="Miss" variant="secondary" onPress={() => void closeToday('miss')} />
      </Card>

      <SectionTitle>Trust & control</SectionTitle>
      <Card><CardTitle>See exactly how APM works with your information.</CardTitle><Body muted>Inspect your data, AI processing, providers, connections, permissions and activity.</Body><Button label="Open Privacy & AI" variant="secondary" onPress={() => router.push('/settings/privacy')} /><Button label="Settings" variant="secondary" onPress={() => router.push('/settings')} /></Card>
    </Screen>
  );
}
