import { router } from 'expo-router';
import { Body, Button, Screen } from '../src/components/ui';

/**
 * Any link that matches no screen (an old link, a typo, a stale deep link). Replaces Expo
 * Router's default "Unmatched Route" page, which was black, unbranded and listed every route
 * behind a "Sitemap" link. One way out: the app's front door, which sends her to Today, her
 * next setup question or the welcome page.
 */
export default function NotFound() {
  return (
    <Screen fullBleed eyebrow="A Player Mode" title="This page isn't here.">
      <Body muted>The link may be old or mistyped. Nothing you saved is affected.</Body>
      <Button label="Open A Player Mode" onPress={() => router.replace('/')} />
    </Screen>
  );
}
