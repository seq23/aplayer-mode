import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Label,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';

export default function ApmScreen() {
  return (
    <Screen
      eyebrow="APM"
      title="Ask APM."
      subtitle="Conversation is a control surface for your system—not the system itself."
    >
      <Card>
        <Label>You</Label>
        <Body>Remember I promised Sarah the deck tomorrow.</Body>
      </Card>

      <Card tone="accent">
        <Label>APM</Label>
        <Body>I can add that as a structured commitment tied to Sarah and tomorrow.</Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Will change Life Graph</Pill>
        </View>
        <CardTitle>Commitment preview</CardTitle>
        <Body muted>Send Sarah the deck · due tomorrow · source: conversation</Body>
        <Button label="Add commitment" onPress={() => {}} />
        <Button label="Edit" variant="secondary" onPress={() => {}} />
      </Card>

      <SectionTitle>Useful prompts</SectionTitle>
      <Card>
        <Body>“What’s falling through the cracks?”</Body>
        <Body>“Why is this my #1 move?”</Body>
        <Body>“I’m wiped today.”</Body>
        <Body>“What changed in my goals this week?”</Body>
      </Card>
    </Screen>
  );
}
