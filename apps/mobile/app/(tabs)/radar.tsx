import { router } from 'expo-router';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
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
      <View style={uiStyles.row}>
        <Pill tone={highAttention.length > 0 ? 'warning' : 'success'}>{highAttention.length} high attention</Pill>
        <Pill>{items.length} open</Pill>
      </View>

      <SectionTitle>Needs attention</SectionTitle>
      {items.length === 0 ? (
        <Card tone="muted">
          <CardTitle>Nothing justified right now.</CardTitle>
          <Body muted>Radar is intentionally quiet until durable state gives APM a reason to interrupt you.</Body>
        </Card>
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
