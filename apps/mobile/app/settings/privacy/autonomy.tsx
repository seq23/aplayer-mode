import { View } from 'react-native';
import {
  Body,
  Card,
  CardTitle,
  Flow,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { autonomyFixtures } from '../../../src/fixtures/trust';

export default function AutonomyScreen() {
  return (
    <Screen
      eyebrow="Permissions & Autonomy"
      title="APM never grants itself authority."
      subtitle="A subscription can make a capability available. You still decide whether APM may use it in each part of your life."
    >
      <Card tone="accent">
        <Flow
          steps={[
            'Observe',
            'Remind',
            'Recommend',
            'Prepare',
            'Approve & execute',
            'Autopilot',
          ]}
        />
      </Card>

      <SectionTitle>Domain permissions · fixture</SectionTitle>
      <View style={uiStyles.stack}>
        {autonomyFixtures.map((item) => (
          <Card key={item.domain}>
            <View style={uiStyles.row}>
              <CardTitle>{item.domain}</CardTitle>
              <Pill>{item.level}</Pill>
            </View>
            <KeyValue label="Current behavior" value={item.detail} />
          </Card>
        ))}
      </View>

      <Card tone="warning">
        <CardTitle>Locked rule</CardTitle>
        <Body>
          Ordinary usage, repeated approvals, or upgrading to Autopilot never silently increases a permission. Standing authority must be explicit and revocable.
        </Body>
      </Card>
    </Screen>
  );
}
