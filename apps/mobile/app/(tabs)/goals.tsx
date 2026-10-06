import { router } from 'expo-router';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';
import { useLifeGraph } from '../../src/state/lifeGraph';

const healthTone = {
  on_track: 'success',
  at_risk: 'warning',
  stalled: 'danger',
  unknown: 'neutral',
} as const;

export default function GoalsScreen() {
  const { graph } = useLifeGraph();

  return (
    <Screen
      eyebrow="Goals"
      title="Where APM is taking you."
      subtitle="Goals are connected to evidence, milestones and next actions—not stored as motivational wallpaper."
    >
      {graph.goals.length ? (
        <View style={uiStyles.stack}>
          {graph.goals.map((goal) => (
            <Card key={goal.id} tone={goal.priority === 1 ? 'accent' : 'default'}>
              <View style={uiStyles.row}>
                <Pill tone={healthTone[goal.health]}>{goal.health.replace('_', ' ')}</Pill>
                {goal.priority === 1 ? <Pill>Primary</Pill> : null}
              </View>
              <CardTitle>{goal.title}</CardTitle>
              <KeyValue label="Pillar" value={goal.pillar ?? 'Not set'} />
              <KeyValue label="Status" value={goal.status} />
              <KeyValue label="Source" value="You told APM during onboarding" />
            </Card>
          ))}
        </View>
      ) : (
        <Card tone="accent">
          <CardTitle>No goal in your Life Graph yet.</CardTitle>
          <Body muted>Start with one concrete 90-day outcome. APM will use it to shape Today, Radar and future planning.</Body>
          <Button label="Build my APM" onPress={() => router.push('/onboarding')} />
        </Card>
      )}

      <SectionTitle>How progress works</SectionTitle>
      <Card>
        <Body>Goal → Milestone → Project/System → Commitment → Next Action → Evidence → Outcome</Body>
      </Card>

      <SectionTitle>What comes next</SectionTitle>
      <Card>
        <Pill>Next implementation slice</Pill>
        <CardTitle>Turn the primary goal into a milestone and next action.</CardTitle>
        <Body muted>That closes the first real loop from onboarding into Today instead of leaving the goal as passive profile data.</Body>
      </Card>
    </Screen>
  );
}
