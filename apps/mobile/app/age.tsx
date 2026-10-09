import { router, useLocalSearchParams } from 'expo-router';
import { AgeGateView } from '../src/components/consent/ConsentViews';

/**
 * Step one of "Start": 18+ before anything is asked or any session exists. From "Join the
 * Founding 100" (next=join) it returns to the checkout; the health-data choice comes after
 * payment, before the setup questions.
 */
export default function AgeScreen() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  return <AgeGateView onConfirmed={() => (next === 'join' ? router.replace('/join') : router.replace('/health-consent'))} />;
}
