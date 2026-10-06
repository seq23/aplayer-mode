import { router } from 'expo-router';
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
  const { graph, completeNextAction, syncStatus, syncError, isDurable, refresh } = useLifeGraph();
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const primaryAction = graph.nextActions.find(
    (action) => action.goalId === primaryGoal?.id && action.status !== 'dismissed',
  );
  const completionEvidence = graph.evidence.find((item) => item.relatedActionId === primaryAction?.id);
  const name = graph.identity.displayName || 'there';
  const saving = syncStatus === 'saving';

  return (
    <Screen
      eyebrow="Today · Early build"
      title={`Good morning, ${name}.`}
      subtitle={
        primaryGoal
          ? 'APM has your first goal in the Life Graph and has turned it into a concrete next action.'
          : 'APM is ready to build your first Life Graph.'
      }
    >
      {syncError ? (
        <Card tone="warning">
          <CardTitle>APM couldn't sync that change.</CardTitle>
          <Body muted>{syncError}</Body>
          <Button label="Retry sync" variant="secondary" onPress={() => void refresh()} />
        </Card>
      ) : null}

      <Card tone="accent">
        <Label>Your #1 move</Label>
        <CardTitle>{primaryAction?.title ?? primaryGoal?.title ?? 'Finish your APM onboarding'}</CardTitle>
        <Body muted>
          {primaryGoal
            ? `Primary pillar: ${primaryGoal.pillar ?? 'not set'}. Completion is recorded as evidence in your Life Graph.`
            : 'Add one concrete 90-day outcome so APM can start planning around it.'}
        </Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Life Graph</Pill>
          <Pill>{primaryAction?.estimatedMinutes ? `${primaryAction.estimatedMinutes} min` : 'Setup'}</Pill>
          <Pill tone={isDurable ? 'success' : 'warning'}>{isDurable ? 'Durable' : 'Local build'}</Pill>
          {primaryAction?.status === 'done' ? <Pill tone="success">Complete</Pill> : null}
        </View>
        {!primaryGoal ? (
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        ) : primaryAction?.status === 'done' ? (
          <Body>Done. APM recorded completion evidence instead of relying on chat memory.</Body>
        ) : primaryAction ? (
          <Button
            label={saving ? 'Recording…' : 'Mark #1 move complete'}
            onPress={() => void completeNextAction(primaryAction.id)}
          />
        ) : null}
      </Card>

      {completionEvidence ? (
        <Card>
          <Label>Evidence recorded</Label>
          <CardTitle>{completionEvidence.summary}</CardTitle>
          <KeyValue label="Source" value="You marked it complete" />
          <KeyValue label="Recorded" value={new Date(completionEvidence.createdAt).toLocaleString()} />
        </Card>
      ) : null}

      <SectionTitle>APM noticed</SectionTitle>
      <Card tone="warning">
        <Pill tone="warning">Promised · due today</Pill>
        <CardTitle>Send David the deck</CardTitle>
        <Body muted>
          Fixture example: APM detected a commitment, the due date is today, and no completion evidence exists.
        </Body>
        <Button label="Why am I seeing this?" variant="secondary" onPress={() => router.push('/radar/why')} />
      </Card>

      <SectionTitle>Your run of show</SectionTitle>
      <Card>
        <KeyValue label="First" value={primaryAction?.title ?? 'Complete onboarding'} />
        <KeyValue label="Then" value="Review anything APM noticed" />
        <KeyValue label="Later" value="Close or reschedule open loops" />
      </Card>

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
