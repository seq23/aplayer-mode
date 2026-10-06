import { router } from 'expo-router';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';

export default function RadarScreen() {
  return (
    <Screen
      eyebrow="Radar"
      title="What APM sees coming."
      subtitle="High-value signals only. Radar should feel useful, not noisy."
    >
      <View style={uiStyles.row}>
        <Pill tone="warning">1 needs attention</Pill>
        <Pill>2 coming up</Pill>
      </View>

      <SectionTitle>Needs attention</SectionTitle>
      <Card tone="warning">
        <Pill tone="warning">Promised · due today</Pill>
        <CardTitle>Send David the deck</CardTitle>
        <Body muted>
          You promised it for today. APM has not found evidence that the loop is closed.
        </Body>
        <Button label="Why APM saw this" variant="secondary" onPress={() => router.push('/radar/why')} />
        <Button label="Mark complete" onPress={() => {}} />
      </Card>

      <SectionTitle>Coming up</SectionTitle>
      <Card>
        <Pill>Upcoming</Pill>
        <CardTitle>Quarterly goal checkpoint in 5 days</CardTitle>
        <Body muted>APM will compare current evidence to the milestone before recommending a replan.</Body>
      </Card>
      <Card>
        <Pill>Opportunity</Pill>
        <CardTitle>Two open focus windows this week</CardTitle>
        <Body muted>Once Calendar is connected, APM can ground this recommendation in your real schedule.</Body>
      </Card>
    </Screen>
  );
}
