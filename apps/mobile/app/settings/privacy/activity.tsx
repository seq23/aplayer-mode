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
} from '../../../src/components/ui';
import { activityFixtures } from '../../../src/fixtures/trust';

export default function ActivityScreen() {
  return (
    <Screen
      eyebrow="APM Activity"
      title="See what APM did."
      subtitle="Consequential behavior should be attributable, inspectable and auditable."
    >
      <Card tone="accent">
        <View style={uiStyles.row}>
          <Pill tone="success">Fixture mode</Pill>
        </View>
        <CardTitle>No external action has been executed.</CardTitle>
        <Body muted>This screen demonstrates the audit experience before real integrations and actions exist.</Body>
      </Card>

      <SectionTitle>Activity timeline</SectionTitle>
      <View style={uiStyles.stack}>
        {activityFixtures.map((item) => (
          <Card key={`${item.time}-${item.title}`}>
            <KeyValue label={item.time} value={item.title} />
            <Body muted>{item.detail}</Body>
          </Card>
        ))}
      </View>

      <Card>
        <CardTitle>Later, consequential actions will show more.</CardTitle>
        <Body muted>What happened · why · source · permission used · whether AI participated · execution result · verification state.</Body>
      </Card>
    </Screen>
  );
}
