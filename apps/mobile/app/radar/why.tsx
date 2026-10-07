import { router, useLocalSearchParams } from 'expo-router';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Flow,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
} from '../../src/components/ui';
import { radarTag } from '../../src/content/words';
import { useLifeGraph } from '../../src/state/lifeGraph';

const reasonText: Record<string, string> = {
  'goal.no_open_next_action': 'The active goal has no open or scheduled next action.',
  'goal.deadline_near': 'The goal target date is within the Radar attention window.',
  'goal.deadline_overdue': 'The goal target date has passed without the goal being closed.',
  'goal.health_at_risk': 'The goal is explicitly marked at risk.',
  'goal.health_stalled': 'The goal is explicitly marked stalled.',
};

export default function RadarWhyScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { graph } = useLifeGraph();
  const item = graph.radarItems.find((candidate) => candidate.id === id);

  if (!item) {
    return (
      <Screen title="That Radar signal is no longer active.">
        <Card tone="muted">
          <Body muted>Something changed since, so APM no longer has a reason to show it.</Body>
        </Card>
        <Button label="Back to Radar" onPress={() => router.replace('/(tabs)/radar')} />
      </Screen>
    );
  }

  const explanations = item.reasonCodes.map((code) => reasonText[code] ?? code);

  return (
    <Screen
      title={item.headline}
      subtitle="APM worked this out from what it already knows about you, with fixed rules. No AI model was involved."
    >
      <Card tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'default'}>
        <Pill tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'neutral'}>
          {radarTag(item.type, item.severity)}
        </Pill>
        <CardTitle>{item.summary}</CardTitle>
      </Card>

      <SectionTitle>How APM got here</SectionTitle>
      <Card>
        <Flow steps={explanations} />
      </Card>

      <SectionTitle>Sources</SectionTitle>
      <Card>
        {item.sourceRefs.map((source, index) => (
          <KeyValue
            key={`${source.sourceType}-${source.sourceRef ?? index}`}
            label={source.sourceType}
            value={source.label ?? source.sourceRef ?? 'What APM already knew'}
          />
        ))}
      </Card>

      <SectionTitle>Signal confidence</SectionTitle>
      <Card>
        <KeyValue label="Confidence" value={`${Math.round(item.confidence * 100)}%`} />
        <KeyValue label="Reason rules" value={item.reasonCodes.join(', ')} />
      </Card>

      <Button label="Back to Radar" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
