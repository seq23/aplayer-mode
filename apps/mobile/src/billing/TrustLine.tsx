import { Platform } from 'react-native';
import type { BillingChannel } from '@apm/policy';
import { Body, Card, CardTitle, Label, Stack } from '../components/ui';
import { PREVIEW } from '../preview/flag';
import { appDistribution } from './purchases';
import { trustLines } from './catalog';

/** The channel this build bills through: the iPhone app (and its free web preview) is Apple; a Play build is Google; web and sideload pay by card. */
export function buildBillingChannel(): BillingChannel {
  if (PREVIEW || Platform.OS === 'ios') return 'app_store';
  if (Platform.OS === 'android' && appDistribution() === 'store') return 'google_play';
  return 'web';
}

/** "What your team never does": the four trust lines (src/billing/catalog.ts trustLines), on the paywall and in Settings. */
export function TrustLine({ channel = buildBillingChannel() }: { channel?: BillingChannel }) {
  return (
    <Card tone="muted">
      <CardTitle>What your team never does</CardTitle>
      {trustLines(channel).map((line) => (
        <Stack key={line.title} gap="xs">
          <Label>{line.title}</Label>
          <Body muted>{line.body}</Body>
        </Stack>
      ))}
    </Card>
  );
}
