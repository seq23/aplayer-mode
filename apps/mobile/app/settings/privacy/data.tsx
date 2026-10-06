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

export default function YourDataScreen() {
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

      <SectionTitle>Fixture Life Graph</SectionTitle>
      <View style={uiStyles.stack}>
        {dataFixtures.map((item) => (
          <Card key={`${item.category}-${item.value}`}>
            <View style={uiStyles.row}>
              <Pill>{item.category}</Pill>
              <Pill tone="success">{item.confidence}</Pill>
            </View>
            <CardTitle>{item.value}</CardTitle>
            <KeyValue label="Source" value={item.source} />
            <Button label="Correct this" variant="secondary" onPress={() => {}} />
          </Card>
        ))}
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
