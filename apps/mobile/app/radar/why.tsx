import { router } from 'expo-router';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Flow,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';

export default function RadarWhyScreen() {
  return (
    <Screen
      eyebrow="Why APM saw this"
      title="Send David the deck"
      subtitle="Fixture example of explainable proactive AI."
    >
      <Card tone="warning">
        <View style={uiStyles.row}>
          <Pill tone="warning">Due today</Pill>
          <Pill>High confidence</Pill>
        </View>
        <CardTitle>APM thinks this loop is still open.</CardTitle>
      </Card>

      <SectionTitle>How APM got here</SectionTitle>
      <Card>
        <Flow
          steps={[
            'Detected a commitment in a message you sent',
            'Interpreted the due date as today',
            'Found no completion evidence',
            'Matched it to an active priority',
            'Surfaced it because timing now matters',
          ]}
        />
      </Card>

      <SectionTitle>Sources</SectionTitle>
      <Card>
        <KeyValue label="Gmail" value="Fixture evidence: “I’ll send the deck Friday.”" />
        <KeyValue label="Life Graph" value="Fundraise · active priority" />
        <KeyValue label="State" value="No completion evidence found" />
      </Card>

      <SectionTitle>You remain in control</SectionTitle>
      <Card>
        <Body muted>If APM is wrong, correcting it should update canonical state and improve future behavior.</Body>
        <Button label="Mark complete" onPress={() => router.back()} />
        <Button label="Correct this" variant="secondary" onPress={() => {}} />
        <Button label="Change due date" variant="secondary" onPress={() => {}} />
      </Card>
    </Screen>
  );
}
