import { router } from 'expo-router';
import { View } from 'react-native';
import { Body, Button, Card, CardTitle, Screen, uiStyles } from '../src/components/ui';

export default function WelcomeScreen() {
  return (
    <Screen
      eyebrow="A Player Mode"
      title="The operating system for your life."
      subtitle="Tell APM where you're going. It helps make sure your actual life moves in that direction."
    >
      <View style={uiStyles.stack}>
        <Card>
          <CardTitle>Knows what matters</CardTitle>
          <Body muted>Your goals, commitments, routines and operating rules become a living system.</Body>
        </Card>
        <Card>
          <CardTitle>Notices before you ask</CardTitle>
          <Body muted>APM looks for what is slipping, approaching, waiting or being forgotten.</Body>
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
