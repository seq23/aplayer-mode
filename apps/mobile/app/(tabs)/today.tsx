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
import { useLifeGraph } from '../../src/state/lifeGraph';

export default function TodayScreen() {
  const { graph, todayPlan, completeNextAction, isDurable, syncError } = useLifeGraph();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const primaryAction = todayPlan?.numberOneMove;
  const completionEvidence = graph.evidence.find((item) => item.relatedActionId === primaryAction?.id);
  const firstRadarItem = graph.radarItems[0];
  const name = graph.identity.displayName || 'there';
  const mode = todayPlan?.mode ?? graph.personalOS?.activeMode ?? 'standard';
  const recovery = mode === 'recovery';

  const complete = async () => {
    if (!primaryAction || busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await completeNextAction(primaryAction.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to record completion.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      eyebrow="Today"
      title={`Good morning, ${name}.`}
      subtitle={
        primaryGoal
          ? recovery
            ? 'Recovery Mode is active. Today protects continuity instead of demanding intensity.'
            : 'APM rebuilt Today from your Personal OS, Life Graph and current execution state.'
          : 'APM is ready to build your first durable Personal OS.'
      }
    >
      <View style={uiStyles.row}>
        <Pill tone={isDurable ? 'success' : 'warning'}>{isDurable ? 'Server-backed' : 'Connection needed'}</Pill>
        <Pill tone={recovery ? 'warning' : 'neutral'}>{mode.replace('_', ' ')}</Pill>
        {todayPlan ? <Pill>{todayPlan.completionState.replace('_', ' ')}</Pill> : null}
      </View>

      {!isDurable ? (
        <Card tone="warning">
          <CardTitle>APM is not pretending local state is durable.</CardTitle>
          <Body muted>{syncError ?? 'Reconnect the authenticated APM API before changing private Life Graph state.'}</Body>
        </Card>
      ) : null}

      {recovery ? (
        <Card tone="warning">
          <Label>Minimum Viable Day</Label>
          <CardTitle>One useful thing. No catch-up debt.</CardTitle>
          <Body muted>Continuity beats intensity today. Completing the smallest critical move is enough.</Body>
        </Card>
      ) : null}

      <Card tone="accent">
        <Label>{recovery ? 'Your MVD move' : 'Your #1 move'}</Label>
        <CardTitle>{primaryAction?.title ?? primaryGoal?.title ?? 'Finish your APM onboarding'}</CardTitle>
        <Body muted>
          {primaryGoal
            ? `Primary pillar: ${primaryGoal.pillar ?? 'not set'}. Today is projected by the server from durable Personal OS + Life Graph state.`
            : 'Build your Personal OS so APM can start planning around your actual game.'}
        </Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Life Graph</Pill>
          <Pill>{primaryAction?.estimatedMinutes ? `${primaryAction.estimatedMinutes} min` : 'Setup'}</Pill>
        </View>
        {!primaryGoal ? (
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        ) : primaryAction ? (
          <Button label={busy ? 'Recording…' : recovery ? 'Complete my MVD move' : 'Mark #1 move complete'} onPress={() => void complete()} />
        ) : (
          <Body>There is no open next action. Radar will flag the missing execution path.</Body>
        )}
      </Card>

      {actionError ? (
        <Card tone="danger">
          <Body>{actionError}</Body>
        </Card>
      ) : null}

      {completionEvidence ? (
        <Card>
          <Label>Evidence recorded</Label>
          <CardTitle>{completionEvidence.summary}</CardTitle>
          <KeyValue label="Source" value="You marked it complete" />
          <KeyValue label="Recorded" value={new Date(completionEvidence.createdAt).toLocaleString()} />
        </Card>
      ) : null}

      {!recovery ? (
        <>
          <SectionTitle>APM noticed</SectionTitle>
          {firstRadarItem ? (
            <Card tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'default'}>
              <Pill tone={firstRadarItem.severity === 'critical' || firstRadarItem.severity === 'high' ? 'warning' : 'neutral'}>
                {firstRadarItem.type} · {firstRadarItem.severity}
              </Pill>
              <CardTitle>{firstRadarItem.headline}</CardTitle>
              <Body muted>{firstRadarItem.summary}</Body>
              <Button
                label="Why am I seeing this?"
                variant="secondary"
                onPress={() => router.push({ pathname: '/radar/why', params: { id: firstRadarItem.id } })}
              />
            </Card>
          ) : (
            <Card tone="muted">
              <CardTitle>Radar is clear for now.</CardTitle>
              <Body muted>APM found no deterministic high-value signal in the Life Graph it can justify surfacing right now.</Body>
            </Card>
          )}
        </>
      ) : null}

      <SectionTitle>Your run of show</SectionTitle>
      <Card>
        {recovery ? (
          <>
            <KeyValue label="Only move" value={primaryAction?.title ?? 'Create one minimum executable move'} />
            <KeyValue label="Rule" value="No catch-up. Close the day after the continuity move." />
          </>
        ) : (
          <>
            <KeyValue label="First" value={primaryAction?.title ?? 'Create the next executable move'} />
            <KeyValue label="Then" value="Review anything APM noticed" />
            <KeyValue label="Later" value="Close or replan open loops" />
          </>
        )}
      </Card>

      {graph.personalOS ? (
        <Card>
          <Label>Personal OS</Label>
          <KeyValue label="Day start" value={graph.personalOS.accountability.dayStart === 'hard' ? 'Hard Start' : 'Guided Start'} />
          <KeyValue label="Tracks" value={graph.tracks.filter((track) => track.active).map((track) => track.name).join(', ') || 'None'} />
          <Button label="Open APM Coach" variant="secondary" onPress={() => router.push('/(tabs)/apm')} />
        </Card>
      ) : null}

      <SectionTitle>Trust & control</SectionTitle>
      <Card>
        <CardTitle>See exactly how APM works with your information.</CardTitle>
        <Body muted>Inspect your data, AI processing, providers, connections, permissions and activity.</Body>
        <Button label="Open Privacy & AI" variant="secondary" onPress={() => router.push('/settings/privacy')} />
        <Button label="Settings" variant="secondary" onPress={() => router.push('/settings')} />
      </Card>
    </Screen>
  );
}
