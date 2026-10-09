import { router } from 'expo-router';
import { HealthConsentView } from '../src/components/consent/ConsentViews';
import { useIntake } from '../src/intake/store';
import { useSession } from '../src/state/session';

/** Step two of "Start": the separate health-data choice, then the setup questions. */
export default function HealthConsentScreen() {
  const { startAnonymous } = useSession();
  const { track } = useIntake();
  return (
    <HealthConsentView
      onDecided={() => {
        // Silent anonymous session (when the project allows it); the consent provider sends both taps to the server.
        void startAnonymous().catch(() => false);
        track('onboarding_started', {});
        router.replace('/intake');
      }}
    />
  );
}
