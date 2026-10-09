import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AGE_GATE, HEALTH_CONSENT } from '../../content/consent';
import { legalPageUrl, openExternal } from '../../links/external';
import { requestDeletion } from '../../api/apmApi';
import { plainError } from '../../api/errors';
import { useConsent } from '../../state/consent';
import { useSession } from '../../state/session';
import { useTheme } from '../../theme';
import { Body, Button, Card, CardTitle, ErrorState, Fill, Icon, LinkButton, Muted, Row, Screen, Stack } from '../ui';

/**
 * "Are you 18 or older?" One tap confirms; the server records it with its own time. "I'm under
 * 18" never creates anything: a session made on this phone is signed out, and an existing
 * account is offered deletion (the only routes the server leaves open without 18+).
 */
export function AgeGateView({ onConfirmed }: { onConfirmed?: () => void }) {
  const { confirmAge, busy, error } = useConsent();
  const { status, isAnonymous, accessToken, signOut } = useSession();
  const [under, setUnder] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const hasAccount = status === 'signed_in' && !isAnonymous;

  const confirm = async () => { await confirmAge().then(() => onConfirmed?.()).catch(() => undefined); };
  const sayUnder = async () => {
    setUnder(true);
    if (status === 'signed_in' && isAnonymous) await signOut().catch(() => undefined);
  };
  const deleteAccount = async () => {
    if (!accessToken || deleting) return;
    setDeleting(true); setDeleteError(undefined);
    try {
      await requestDeletion(accessToken);
      await signOut().catch(() => undefined);
      router.replace({ pathname: '/welcome', params: { deleted: '1' } });
    } catch (cause) { setDeleteError(plainError(cause, 'Deletion was not requested. Check your connection and try again.')); }
    finally { setDeleting(false); }
  };

  if (under) {
    return (
      <Screen fullBleed eyebrow={AGE_GATE.eyebrow} title={AGE_GATE.underTitle}>
        <Body>{hasAccount ? AGE_GATE.underAccountBody : AGE_GATE.underBody}</Body>
        {deleteError ? <ErrorState message={deleteError} /> : null}
        {hasAccount ? <Button label={AGE_GATE.deleteAccount} variant="danger" busy={deleting} onPress={() => void deleteAccount()} /> : null}
        <LinkButton align="center" label={AGE_GATE.back} onPress={() => setUnder(false)} />
      </Screen>
    );
  }
  return (
    <Screen
      fullBleed
      eyebrow={AGE_GATE.eyebrow}
      title={AGE_GATE.title}
      footer={(
        <>
          <Button label={AGE_GATE.confirm} large busy={busy} onPress={() => void confirm()} />
          <Button label={AGE_GATE.under} variant="secondary" onPress={() => void sayUnder()} />
        </>
      )}
    >
      <Body muted>{AGE_GATE.body}</Body>
      {error ? <ErrorState message={error} /> : null}
    </Screen>
  );
}

/** The separate, explicit consumer health data consent: what, why, and an equal "Not now". */
export function HealthConsentView({ onDecided, footerExtra }: { onDecided?: (granted: boolean) => void; footerExtra?: ReactNode }) {
  const { decideHealth, busy, error } = useConsent();
  const decide = async (granted: boolean) => {
    await decideHealth(granted ? 'granted' : 'declined').then(() => onDecided?.(granted)).catch(() => undefined);
  };
  return (
    <Screen
      fullBleed
      eyebrow={HEALTH_CONSENT.eyebrow}
      title={HEALTH_CONSENT.title}
      footer={(
        <>
          <Button label={HEALTH_CONSENT.agree} large busy={busy} onPress={() => void decide(true)} />
          <Button label={HEALTH_CONSENT.decline} variant="secondary" disabled={busy} onPress={() => void decide(false)} />
          {footerExtra}
        </>
      )}
    >
      <HealthConsentDetails />
      {error ? <ErrorState message={error} /> : null}
    </Screen>
  );
}

export function HealthConsentDetails() {
  return (
    <Stack gap="sm">
      <Body muted>{HEALTH_CONSENT.lead}</Body>
      <Card>
        <CardTitle>What counts as health information in APM</CardTitle>
        {HEALTH_CONSENT.what.map((line) => (
          <Row key={line} gap="xs" align="flex-start"><Icon name="check" size={16} tone="accent" /><Fill><Body>{line}</Body></Fill></Row>
        ))}
      </Card>
      <Body>{HEALTH_CONSENT.why}</Body>
      <Muted>{HEALTH_CONSENT.noLine}</Muted>
      <LinkButton role="link" label={HEALTH_CONSENT.policyLink} onPress={() => void openExternal({ kind: 'web', url: legalPageUrl('consumer-health') })} />
    </Stack>
  );
}

/**
 * Over the whole app: a signed-in person the server has no 18+ confirmation for sees the age
 * screen (accounts made before this, or from "I have an account"); after that, anyone never
 * asked about health data is asked once. The navigator stays mounted underneath.
 */
export function ConsentGate() {
  const { needsAge, needsHealthDecision } = useConsent();
  const { colors } = useTheme();
  if (!needsAge && !needsHealthDecision) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      {needsAge ? <AgeGateView /> : <HealthConsentView />}
    </View>
  );
}
