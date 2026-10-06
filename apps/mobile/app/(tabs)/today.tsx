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
  const { graph } = useLifeGraph();
  const primaryGoal = graph.goals.find((goal) => goal.priority === 1) ?? graph.goals[0];
  const name = graph.identity.displayName || 'there';

  return (
    <Screen
      eyebrow="Today · Early build"
      title={`Good morning, ${name}.`}
      subtitle={
        primaryGoal
          ? 'APM has your first goal in the Life Graph. The next step is turning it into a daily execution system.'
          : 'APM is ready to build your first Life Graph.'
      }
    >
      <Card tone="accent">
        <Label>Your #1 move</Label>
        <CardTitle>{primaryGoal?.title ?? 'Finish your APM onboarding'}</CardTitle>
        <Body muted>
          {primaryGoal
            ? `Primary pillar: ${primaryGoal.pillar ?? 'not set'}. This goal is now structured state—not just chat history.`
            : 'Add one concrete 90-day outcome so APM can start planning around it.'}
        </Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Life Graph</Pill>
          <Pill>{primaryGoal ? 'Priority 1' : 'Setup'}</Pill>
        </View>
        {!primaryGoal ? (
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        ) : (
          <Button label="Start focus block" onPress={() => {}} />
        )}
      </Card>

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
        <KeyValue label="First" value={primaryGoal ? `Advance: ${primaryGoal.title}` : 'Complete onboarding'} />
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
