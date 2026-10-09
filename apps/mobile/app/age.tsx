import { router } from 'expo-router';
import { AgeGateView } from '../src/components/consent/ConsentViews';

/** Step one of "Start": 18+ before anything is asked or any session exists. */
export default function AgeScreen() {
  return <AgeGateView onConfirmed={() => router.replace('/health-consent')} />;
}
