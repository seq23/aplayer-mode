import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, ErrorState, LinkButton, ListRow, Muted, Pill, Screen, SectionTitle } from '../../../src/components/ui';
import { HealthConsentDetails } from '../../../src/components/consent/ConsentViews';
import { HEALTH_SETTINGS } from '../../../src/content/consent';
import { legalPageUrl, openExternal } from '../../../src/links/external';
import { useConsent } from '../../../src/state/consent';

/** Settings → Privacy → Consumer health data: the current choice, withdraw or give it, and where deletion lives. */
export default function HealthDataScreen() {
  const { healthDecision, healthRecordedAt, decideHealth, busy, error } = useConsent();
  const on = healthDecision === 'granted';
  const when = healthRecordedAt ? new Date(healthRecordedAt).toLocaleDateString() : undefined;
  const label = healthDecision === 'granted' ? 'Given' : healthDecision === 'withdrawn' ? 'Withdrawn' : healthDecision === 'declined' ? 'Declined' : undefined;
  return (
    <Screen title={HEALTH_SETTINGS.title} subtitle={HEALTH_SETTINGS.subtitle}>
      {error ? <ErrorState message={error} /> : null}
      <Card tone={on ? 'accent' : 'default'}>
        <Pill tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Pill>
        <Body>{healthDecision ? (on ? HEALTH_SETTINGS.on : HEALTH_SETTINGS.off) : HEALTH_SETTINGS.unset}</Body>
        {label && when ? <Muted>{HEALTH_SETTINGS.recorded(label, when)}</Muted> : null}
        {on ? (
          <>
            <Button label={HEALTH_SETTINGS.withdraw} variant="danger" busy={busy} onPress={() => void decideHealth('withdrawn').catch(() => undefined)} />
            <Muted>{HEALTH_SETTINGS.withdrawNote}</Muted>
          </>
        ) : (
          <Button label={HEALTH_SETTINGS.grant} busy={busy} onPress={() => void decideHealth('granted').catch(() => undefined)} />
        )}
      </Card>
      <SectionTitle>What this covers</SectionTitle>
      <HealthConsentDetails />
      <Card>
        <CardTitle>Delete what is already stored</CardTitle>
        <Body muted>Withdrawing stops collection. Deleting your account erases everything, health information included.</Body>
        <ListRow title={HEALTH_SETTINGS.exportDelete} icon="download" accessibilityLabel="Open Export & Delete" onPress={() => router.push('/settings/privacy/export-delete')} />
      </Card>
      <LinkButton role="link" label={HEALTH_SETTINGS.policyLink} onPress={() => void openExternal({ kind: 'web', url: legalPageUrl('consumer-health') })} />
    </Screen>
  );
}
