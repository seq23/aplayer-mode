import { router } from 'expo-router';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  ListItem,
  Screen,
  SectionTitle,
  uiStyles,
} from '../src/components/ui';
import { trustPromises } from '../src/fixtures/trust';

export default function PrivacyPrimerScreen() {
  return (
    <Screen
      eyebrow="Before we begin"
      title="Your life is yours."
      subtitle="A Player Mode works best when it understands what matters to you. You choose what to share and which accounts to connect."
    >
      <Card tone="accent">
        <CardTitle>The short version</CardTitle>
        <Body>
          We do not sell your personal data. Approved AI providers may not train public models on your private APM data. APM learns you through your private Life Graph—not by training a public foundation model on your life.
        </Body>
      </Card>

      <SectionTitle>What that means</SectionTitle>
      <View style={uiStyles.stack}>
        {trustPromises.map((item) => (
          <Card key={item.title}>
            <ListItem title={item.title} detail={item.detail} />
          </Card>
        ))}
      </View>

      <Button label="Continue" onPress={() => router.replace('/(tabs)/today')} />
      <Button
        label="How APM uses AI"
        variant="secondary"
        onPress={() => router.push('/settings/privacy/how-ai-works')}
      />
    </Screen>
  );
}
