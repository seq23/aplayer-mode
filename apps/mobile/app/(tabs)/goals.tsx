import { View } from 'react-native';
import {
  Body,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';

export default function GoalsScreen() {
  return (
    <Screen
      eyebrow="Goals"
      title="Where APM is taking you."
      subtitle="Goals are connected to evidence, milestones and next actions—not stored as motivational wallpaper."
    >
      <Card tone="accent">
        <View style={uiStyles.row}>
          <Pill tone="success">On track</Pill>
          <Pill>Primary</Pill>
        </View>
        <CardTitle>Launch A Player Mode Chief of Staff</CardTitle>
        <KeyValue label="Next milestone" value="Trust Center mobile shell" />
        <KeyValue label="Evidence" value="Privacy UX + architecture locked; mobile scaffold underway" />
        <KeyValue label="Next action" value="Finish Trust Center fixture screens" />
      </Card>

      <SectionTitle>How progress works</SectionTitle>
      <Card>
        <Body>Goal → Milestone → Project/System → Commitment → Next Action → Evidence → Outcome</Body>
      </Card>

      <SectionTitle>Fixture goal</SectionTitle>
      <Card>
        <Pill tone="warning">At risk</Pill>
        <CardTitle>Build a consistent training routine</CardTitle>
        <Body muted>APM would use routine completion, calendar reality and user rules—not chat sentiment alone—to assess progress.</Body>
      </Card>
    </Screen>
  );
}
