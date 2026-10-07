import { Redirect } from 'expo-router';
import { Body, Button, Card, CardTitle, Screen } from '../src/components/ui';
import { useLifeGraph } from '../src/state/lifeGraph';
import { useSession } from '../src/state/session';
import { useIntake } from '../src/intake/store';

/**
 * Where the app opens: an installed OS → Today; an unfinished setup → the next unanswered
 * question ("Welcome back. Your answers are saved."); otherwise the welcome page.
 */
export default function Index() {
  const { status } = useSession();
  const { graph, syncStatus, syncError, refresh } = useLifeGraph();
  const { draft } = useIntake();
  const started = Object.keys(draft.answers).length > 0;

  if (status === 'loading' || (status === 'signed_in' && (syncStatus === 'idle' || syncStatus === 'loading'))) {
    return <Screen eyebrow="A Player Mode" title="Opening your APM…">{null}</Screen>;
  }

  if (status === 'signed_in' && syncStatus === 'error' && !started) {
    return (
      <Screen eyebrow="A Player Mode" title="We couldn't reach your APM yet.">
        <Card tone="warning">
          <CardTitle>Everything on this phone is safe.</CardTitle>
          <Body muted>{syncError?.includes('configured') ? 'Setup isn\'t finished on this build.' : 'Check your connection and try again.'}</Body>
        </Card>
        <Button label="Try again" onPress={() => void refresh()} />
      </Screen>
    );
  }

  if (status === 'signed_in' && graph.personalOS) return <Redirect href="/(tabs)/today" />;
  if (started || status === 'signed_in') return <Redirect href="/intake" />;
  return <Redirect href="/welcome" />;
}
