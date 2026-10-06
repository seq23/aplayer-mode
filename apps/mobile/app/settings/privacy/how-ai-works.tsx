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
      eyebrow="How APM uses AI"
      title="AI helps reason. Your Life Graph holds your life."
      subtitle="APM does not send everything it knows to an AI model every time."
    >
      <Card tone="accent">
        <Flow
          steps={[
            'Your private Life Graph',
            'APM selects relevant context',
            'Privacy Gateway checks sensitivity',
            'Approved AI inference',
            'Validated result',
            'Your APM experience updates',
          ]}
        />
      </Card>

      <SectionTitle>What APM is designed to do</SectionTitle>
      <Card>
        <ListItem title="Use deterministic code first" detail="Dates, conflicts, completion counts and state transitions should not need an LLM." />
        <ListItem title="Minimize context" detail="An AI task receives the information it needs—not your whole Life Graph by default." />
        <ListItem title="Route by privacy first" detail="Privacy eligibility → capability → reliability → cost → latency." />
        <ListItem title="Validate model output" detail="A model response is untrusted input until APM validates it." />
      </Card>

      <Card>
        <CardTitle>Learning is not model training.</CardTitle>
        <Body>
          If APM learns that you prefer workouts before noon, that preference can be stored privately in your Life Graph. It does not require a public foundation model to train on your calendar history.
        </Body>
      </Card>

      <Button label="See current AI providers" onPress={() => router.push('/settings/privacy/providers')} />
    </Screen>
  );
}
