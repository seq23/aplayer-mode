import { router } from 'expo-router';
import { AccountPanel } from '../src/components/intake/AccountPanel';
import { Screen } from '../src/components/ui';

/** "I already have an account": straight to Today, or to the next unanswered question if setup is unfinished. */
export default function AccountScreen() {
  return (
    <Screen fullBleed>
      <AccountPanel
        title="Welcome back"
        sub="Sign in the way you saved your plan. No passwords."
        onDone={() => router.replace('/')}
        onLater={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))}
        laterLabel="Back"
      />
    </Screen>
  );
}
