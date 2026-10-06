import { router } from 'expo-router';
import { View } from 'react-native';
import { Body, Button, Card, CardTitle, Screen, uiStyles } from '../src/components/ui';

export default function WelcomeScreen() {
  return (
    <Screen
      eyebrow="A Player Mode"
      title="Whatever game you're in, get into A Player Mode."
      subtitle="A Player Mode turns what matters to you into a working system—then helps keep your goals, commitments, routines and next moves from falling through the cracks."
    >
      <Card tone="accent">
        <CardTitle>Built for the game you're playing now</CardTitle>
        <Body muted>
          Parent. Athlete. Entrepreneur. Student. Professional. Creator. Caregiver. Or simply someone in a season that matters.
        </Body>
      </Card>

      <View style={uiStyles.stack}>
        <Card>
          <CardTitle>Knows what matters</CardTitle>
          <Body muted>Your roles, goals, commitments, routines and operating rules become a living system.</Body>
        </Card>
        <Card>
          <CardTitle>Notices before you ask</CardTitle>
          <Body muted>APM looks for what is slipping, approaching, waiting or being forgotten in your actual life.</Body>
        </Card>
        <Card>
          <CardTitle>Acts only with your permission</CardTitle>
          <Body muted>You decide how much authority APM has in each part of your life.</Body>
        </Card>
      </View>

      <Button label="Build my A Player Mode" onPress={() => router.push('/privacy-primer')} />
    </Screen>
  );
}
