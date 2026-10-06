import { useState } from 'react';
import { View } from 'react-native';
import type { OperatingModeKey } from '@apm/domain';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Label,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';
import { useLifeGraph } from '../../src/state/lifeGraph';

const modeCopy: Record<OperatingModeKey, { label: string; description: string; opening: string }> = {
  standard: {
    label: 'Standard',
    description: 'Normal execution. Keep the plan boring and clear.',
    opening: 'What feels most important to get clear on before you execute?',
  },
  recovery: {
    label: 'Recovery',
    description: 'Reduce scope. Protect continuity. No catch-up.',
    opening: 'What is the smallest useful thing you can do today without making tomorrow harder?',
  },
  high_pressure: {
    label: 'High-Pressure',
    description: 'Direct challenge for avoidance or a hard decision. No shame, no theatrics.',
    opening: 'What decision or action are you avoiding right now?',
  },
  executive_review: {
    label: 'Executive Review',
    description: 'Organize what exists and make decisions without adding new projects.',
    opening: 'What is creating the most noise or ambiguity in your current system?',
  },
};

export default function ApmScreen() {
  const { graph, todayPlan, setOperatingMode, isDurable } = useLifeGraph();
  const [busyMode, setBusyMode] = useState<OperatingModeKey>();
  const [error, setError] = useState<string>();
  const activeMode = graph.personalOS?.activeMode ?? todayPlan?.mode ?? 'standard';
  const active = modeCopy[activeMode];

  const changeMode = async (mode: OperatingModeKey) => {
    if (!isDurable || busyMode) return;
    setBusyMode(mode);
    setError(undefined);
    try {
      await setOperatingMode(mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change APM mode.');
    } finally {
      setBusyMode(undefined);
    }
  };

  return (
    <Screen
      eyebrow="APM Coach"
      title="Your system changes with your state—not your standards."
      subtitle="Modes change how APM holds the day. Your Personal OS remains the source of truth."
    >
      <Card tone="accent">
        <Label>Active mode</Label>
        <CardTitle>{active.label}</CardTitle>
        <Body>{active.description}</Body>
        <View style={uiStyles.row}>
          <Pill tone="success">Durable Personal OS</Pill>
          <Pill>{graph.personalOS?.accountability.dayStart === 'hard' ? 'Hard Start' : 'Guided Start'}</Pill>
        </View>
      </Card>

      <SectionTitle>Change mode</SectionTitle>
      <Card>
        <Body muted>Mode changes are explicit. APM does not silently escalate coaching intensity.</Body>
        {(Object.keys(modeCopy) as OperatingModeKey[]).map((mode) => (
          <Button
            key={mode}
            label={busyMode === mode ? 'Saving…' : modeCopy[mode].label}
            variant={activeMode === mode ? 'primary' : 'secondary'}
            onPress={() => void changeMode(mode)}
          />
        ))}
      </Card>

      {error ? (
        <Card tone="danger">
          <Body>{error}</Body>
        </Card>
      ) : null}

      <SectionTitle>Coaching opening</SectionTitle>
      <Card>
        <Label>APM</Label>
        <CardTitle>{active.opening}</CardTitle>
        <Body muted>
          Methodology v1 supplies the deterministic mode, guardrails and opening question. Live conversational AI is intentionally not connected until the approved model routes are ready.
        </Body>
      </Card>

      <SectionTitle>Your background tracks</SectionTitle>
      <Card>
        {graph.tracks.length ? (
          graph.tracks.filter((track) => track.active).map((track) => (
            <View key={track.id} style={uiStyles.stack}>
              <CardTitle>{track.name}</CardTitle>
              <Body muted>Background decision filter · not a daily task list</Body>
            </View>
          ))
        ) : (
          <Body muted>No tracks installed yet. Complete the Personal OS intake to choose them.</Body>
        )}
      </Card>

      <SectionTitle>Core laws</SectionTitle>
      <Card>
        <Body>Never Miss Twice</Body>
        <Body>Continuity &gt; Intensity</Body>
        <Body>No Catch-Up</Body>
        <Body>No Mid-Day Negotiation</Body>
        <Body>Zeros Are Allowed</Body>
        <Body>Minimum Viable Day</Body>
      </Card>
    </Screen>
  );
}
