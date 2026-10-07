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
import { radarTag } from '../../src/content/words';

export default function RadarScreen() {
  const { graph } = useLifeGraph();
  const items = graph.radarItems.filter((item) => item.status === 'open');
  const highAttention = items.filter((item) => item.severity === 'critical' || item.severity === 'high');

  return (
    <Screen
      eyebrow="Radar"
      title="What APM sees coming."
      subtitle="Promises, deadlines and replies that are about to slip. APM only shows what it can explain."
    >
      {items.length ? (
        <Row wrap gap="xs">
          {highAttention.length ? <Pill tone="warning">{`${highAttention.length} important`}</Pill> : null}
          <Pill>{`${items.length} open`}</Pill>
        </Row>
      ) : null}

      <SectionTitle>Needs attention</SectionTitle>
      {items.length === 0 ? (
        <EmptyState icon="compass" title="Nothing slipping right now." body="Radar stays quiet until something really needs you. Connect your calendar or email and it watches those too." actionLabel="Connect an account" onAction={() => router.push('/settings/privacy/connections')} />
      ) : (
        items.map((item) => (
          <Card key={item.id} tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'default'}>
            <Pill tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'neutral'}>
              {radarTag(item.type, item.severity)}
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
