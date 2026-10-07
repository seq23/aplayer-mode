import { router } from 'expo-router';
import {
  Body,
  Card,
  CardTitle,
  Fill,
  Icon,
  ListRow,
  Row,
  Screen,
  SectionTitle,
  type IconName,
} from '../../../src/components/ui';

const destinations = [
  {
    title: 'Your Data',
    detail: 'See what APM knows, where it came from and what you can correct.',
    href: '/settings/privacy/data' as const,
    icon: 'database' as IconName,
  },
  {
    title: 'How APM Uses AI',
    detail: 'What AI sees, what it never sees, and why.',
    href: '/settings/privacy/how-ai-works' as const,
    icon: 'cpu' as IconName,
  },
  {
    title: 'AI Providers',
    detail: 'Which AI services APM may use, and their privacy terms.',
    href: '/settings/privacy/providers' as const,
    icon: 'server' as IconName,
  },
  {
    title: 'Connections',
    detail: 'See what external accounts are connected and exactly what APM can access.',
    href: '/settings/privacy/connections' as const,
    icon: 'link' as IconName,
  },
  {
    title: 'Permissions & Autonomy',
    detail: 'Control how much authority APM has in each domain.',
    href: '/settings/privacy/autonomy' as const,
    icon: 'sliders' as IconName,
  },
  {
    title: 'APM Activity',
    detail: 'See what APM noticed, changed, prepared or executed.',
    href: '/settings/privacy/activity' as const,
    icon: 'activity' as IconName,
  },
  {
    title: 'Export & Delete',
    detail: 'Export your APM data or start account/data deletion.',
    href: '/settings/privacy/export-delete' as const,
    icon: 'download' as IconName,
  },
] as const;

export default function PrivacyCenterScreen() {
  return (
    <Screen
      title="Your life is yours."
      subtitle="Plain-language controls for what APM knows, how AI processes it, and what APM is allowed to do."
    >
      <Card tone="accent">
        <CardTitle>APM learns you. Public AI models do not.</CardTitle>
        <Row gap="xs"><Icon name="check" size={16} tone="accent" /><Fill><Body>Your data is never sold.</Body></Fill></Row>
        <Row gap="xs"><Icon name="check" size={16} tone="accent" /><Fill><Body>Your private life never trains a public AI model.</Body></Fill></Row>
        <Row gap="xs"><Icon name="check" size={16} tone="accent" /><Fill><Body>What APM learns about you stays in your own account.</Body></Fill></Row>
      </Card>

      <SectionTitle>Understand & control APM</SectionTitle>
      {destinations.map((item) => (
        <ListRow key={item.title} title={item.title} detail={item.detail} icon={item.icon} accessibilityLabel={`Open ${item.title}`} onPress={() => router.push(item.href)} />
      ))}
    </Screen>
  );
}
