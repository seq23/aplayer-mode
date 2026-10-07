import { router } from 'expo-router';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Flow,
  ListItem,
  Screen,
  SectionTitle,
} from '../../../src/components/ui';

export default function HowAiWorksScreen() {
  return (
    <Screen
      title="AI helps think. Your account holds your life."
      subtitle="APM does not send everything it knows to an AI model every time."
    >
      <Card tone="accent">
        <Flow
          steps={[
            'Your private account',
            'APM picks only what this task needs',
            'A privacy check decides what may leave',
            'An approved AI model answers',
            'APM checks the answer',
            'Your APM experience updates',
          ]}
        />
      </Card>

      <SectionTitle>What APM is designed to do</SectionTitle>
      <Card>
        <ListItem title="Plain code first" detail="Dates, clashes and counts are worked out by APM itself. No AI model needed." />
        <ListItem title="Share the least" detail="An AI task gets only what it needs, never everything APM knows about you." />
        <ListItem title="Privacy decides first" detail="A model is used only if its privacy terms allow it; then quality, then cost." />
        <ListItem title="Check every answer" detail="An AI answer is not trusted until APM has checked it." />
      </Card>

      <Card>
        <CardTitle>Learning is not model training.</CardTitle>
        <Body>
          If APM learns that you prefer workouts before noon, that preference can be stored privately in your account. It does not require a public foundation model to train on your calendar history.
        </Body>
      </Card>

      <Button label="See current AI providers" onPress={() => router.push('/settings/privacy/providers')} />
    </Screen>
  );
}
