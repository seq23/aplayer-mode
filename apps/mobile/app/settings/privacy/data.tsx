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
} from '../../../src/components/ui';
import { dataFixtures } from '../../../src/fixtures/trust';
import { useLifeGraph } from '../../../src/state/lifeGraph';

export default function YourDataScreen() {
  const { graph } = useLifeGraph();
  const hasLiveState = Boolean(graph.identity.displayName || graph.goals.length);

  return (
    <Screen
      eyebrow="Your Data"
      title="What APM knows about you."
      subtitle="Important persistent state should be inspectable, sourced and correctable."
    >
      <Card tone="accent">
        <CardTitle>Your Life Graph is APM's private operating memory.</CardTitle>
        <Body muted>Goals, commitments, routines, people, preferences and rules live here instead of being hidden inside a giant prompt.</Body>
      </Card>

      <SectionTitle>{hasLiveState ? 'Your current Life Graph' : 'Example Life Graph'}</SectionTitle>
      <View style={uiStyles.stack}>
        {graph.identity.displayName ? (
          <Card>
            <View style={uiStyles.row}>
              <Pill>Identity</Pill>
              <Pill tone="success">User stated</Pill>
            </View>
            <CardTitle>{graph.identity.displayName}</CardTitle>
            {graph.identity.currentSeason ? <KeyValue label="Current season" value={graph.identity.currentSeason} /> : null}
            {graph.identity.becoming ? <KeyValue label="Becoming" value={graph.identity.becoming} /> : null}
            <KeyValue label="Source" value="You told APM during onboarding" />
            <Button label="Correct this" variant="secondary" onPress={() => {}} />
          </Card>
        ) : null}

        {graph.goals.map((goal) => (
          <Card key={goal.id}>
            <View style={uiStyles.row}>
              <Pill>Goal</Pill>
              <Pill tone="success">{Math.round((goal.provenance.confidence ?? 1) * 100)}% confidence</Pill>
            </View>
            <CardTitle>{goal.title}</CardTitle>
            <KeyValue label="Pillar" value={goal.pillar ?? 'Not set'} />
            <KeyValue label="Source" value="You told APM during onboarding" />
            <Button label="Correct this" variant="secondary" onPress={() => {}} />
          </Card>
        ))}

        {!hasLiveState
          ? dataFixtures.map((item) => (
              <Card key={`${item.category}-${item.value}`}>
                <View style={uiStyles.row}>
                  <Pill>{item.category}</Pill>
                  <Pill tone="success">{item.confidence}</Pill>
                </View>
                <CardTitle>{item.value}</CardTitle>
                <KeyValue label="Source" value={item.source} />
                <Button label="Correct this" variant="secondary" onPress={() => {}} />
              </Card>
            ))
          : null}
      </View>

      <Card>
        <CardTitle>Production rule</CardTitle>
        <Body>
          APM-derived facts that materially affect your experience must expose provenance and a correction path. Corrected facts cannot be blindly recreated from stale evidence.
        </Body>
      </Card>
    </Screen>
  );
}
