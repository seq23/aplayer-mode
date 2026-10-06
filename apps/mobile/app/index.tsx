import { Redirect } from 'expo-router';
import { Body, Button, Card, CardTitle, Screen } from '../src/components/ui';
import { useLifeGraph } from '../src/state/lifeGraph';
import { useSession } from '../src/state/session';

export default function Index() {
  const { status } = useSession();
  const { graph, syncStatus, syncError, refresh } = useLifeGraph();

  if (status === 'loading' || (status === 'signed_in' && (syncStatus === 'idle' || syncStatus === 'loading'))) {
    return (
      <Screen eyebrow="A Player Mode" title="Loading your APM…" subtitle="Restoring your private Life Graph.">
        {null}
      </Screen>
    );
  }

  if (status === 'signed_in' && syncStatus === 'error') {
    return (
      <Screen eyebrow="A Player Mode" title="We couldn't restore your APM yet.">
        <Card tone="warning">
          <CardTitle>Your local app is safe.</CardTitle>
          <Body muted>{syncError ?? 'The APM API is temporarily unavailable.'}</Body>
        </Card>
        <Button label="Try again" onPress={() => void refresh()} />
      </Screen>
    );
  }

  if (status === 'signed_in') {
    return graph.goals.length > 0 ? <Redirect href="/(tabs)/today" /> : <Redirect href="/onboarding" />;
  }

  return <Redirect href="/welcome" />;
}
