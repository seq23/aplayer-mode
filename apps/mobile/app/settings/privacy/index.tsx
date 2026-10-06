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
} from '../../../src/components/ui';

const destinations = [
  {
    title: 'Your Data',
    detail: 'See what APM knows, where it came from and what you can correct.',
    href: '/settings/privacy/data' as const,
  },
  {
    title: 'How APM Uses AI',
    detail: 'Understand the Privacy Gateway, minimum-context processing and Life Graph.',
    href: '/settings/privacy/how-ai-works' as const,
  },
  {
    title: 'AI Providers',
    detail: 'See current processing routes, training policy and retention class.',
    href: '/settings/privacy/providers' as const,
  },
  {
    title: 'Connections',
    detail: 'See what external accounts are connected and exactly what APM can access.',
    href: '/settings/privacy/connections' as const,
  },
  {
    title: 'Permissions & Autonomy',
    detail: 'Control how much authority APM has in each domain.',
    href: '/settings/privacy/autonomy' as const,
  },
  {
    title: 'APM Activity',
    detail: 'See what APM noticed, changed, prepared or executed.',
    href: '/settings/privacy/activity' as const,
  },
  {
    title: 'Export & Delete',
    detail: 'Export your APM data or start account/data deletion.',
    href: '/settings/privacy/export-delete' as const,
  },
] as const;

export default function PrivacyCenterScreen() {
  return (
    <Screen
      eyebrow="Privacy & AI"
      title="Your life is yours."
      subtitle="Plain-language controls for what APM knows, how AI processes it, and what APM is allowed to do."
    >
      <Card tone="accent">
        <View style={uiStyles.row}>
          <Pill tone="success">No data sale</Pill>
          <Pill tone="success">No private-data public-model training</Pill>
        </View>
        <CardTitle>APM learns you. Public foundation models do not.</CardTitle>
        <Body muted>Personalization belongs in your private Life Graph and operating rules.</Body>
      </Card>

      <SectionTitle>Understand & control APM</SectionTitle>
      <View style={uiStyles.stack}>
        {destinations.map((item) => (
          <Card key={item.title}>
            <CardTitle>{item.title}</CardTitle>
            <Body muted>{item.detail}</Body>
            <Button label={`Open ${item.title}`} variant="secondary" onPress={() => router.push(item.href)} />
          </Card>
        ))}
      </View>
    </Screen>
  );
}
