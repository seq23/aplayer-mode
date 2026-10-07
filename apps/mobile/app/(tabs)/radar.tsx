import { router } from 'expo-router';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Pill,
  Screen,
  Row,
  SectionTitle,
  EmptyState,
} from '../../src/components/ui';
import { useLifeGraph } from '../../src/state/lifeGraph';

export default function RadarScreen() {
  const { graph } = useLifeGraph();
  const items = graph.radarItems.filter((item) => item.status === 'open');
  const highAttention = items.filter((item) => item.severity === 'critical' || item.severity === 'high');

  return (
    <Screen
      eyebrow="Radar"
      title="What APM sees coming."
      subtitle="Deterministic signals only for now. If APM cannot explain the signal from your state, it should not surface it."
    >
      <Row wrap gap="xs">
        <Pill tone={highAttention.length > 0 ? 'warning' : 'success'}>{`${highAttention.length} high attention`}</Pill>
        <Pill>{`${items.length} open`}</Pill>
      </Row>

      <SectionTitle>Needs attention</SectionTitle>
      {items.length === 0 ? (
        <EmptyState icon="compass" title="Nothing justified right now." body="Radar is intentionally quiet until durable state gives APM a reason to interrupt you." />
      ) : (
        items.map((item) => (
          <Card key={item.id} tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'default'}>
            <Pill tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'neutral'}>
              {item.type} · {item.severity}
            </Pill>
            <CardTitle>{item.headline}</CardTitle>
            <Body muted>{item.summary}</Body>
            <Button
              label="Why APM saw this"
              variant="secondary"
              onPress={() => router.push({ pathname: '/radar/why', params: { id: item.id } })}
            />
          </Card>
        ))
      )}
    </Screen>
  );
}
