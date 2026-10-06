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

export default function TodayScreen() {
  return (
    <Screen
      eyebrow="Tuesday · Fixture mode"
      title="Good morning."
      subtitle="APM has one priority move and one thing it wants you to notice."
    >
      <Card tone="accent">
        <Label>Your #1 move</Label>
        <CardTitle>Finish the Chief of Staff trust experience</CardTitle>
        <Body muted>
          The product needs to earn access to private context before it asks for Gmail or Calendar.
        </Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Goal aligned</Pill>
          <Pill>60 min</Pill>
        </View>
        <Button label="Start focus block" onPress={() => {}} />
      </Card>

      <SectionTitle>APM noticed</SectionTitle>
      <Card tone="warning">
        <Pill tone="warning">Promised · due today</Pill>
        <CardTitle>Send David the deck</CardTitle>
        <Body muted>
          Mock example: APM detected a commitment, the due date is today, and no completion evidence exists.
        </Body>
        <Button label="Why am I seeing this?" variant="secondary" onPress={() => router.push('/radar/why')} />
      </Card>

      <SectionTitle>Your run of show</SectionTitle>
      <Card>
        <KeyValue label="9:00–10:30" value="Build trust center screens" />
        <KeyValue label="10:30–10:45" value="Reset + review" />
        <KeyValue label="10:45–12:00" value="Life Graph vertical slice" />
        <KeyValue label="2:00–2:30" value="Architecture review" />
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
