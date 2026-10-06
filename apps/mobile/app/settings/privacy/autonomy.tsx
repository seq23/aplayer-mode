import { useState } from 'react';
import { View } from 'react-native';
import type { AutonomyLevel } from '@apm/domain';
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
  uiStyles,
} from '../../../src/components/ui';
import { setPermission } from '../../../src/api/apmApi';
import { useLifeGraph } from '../../../src/state/lifeGraph';
import { useSession } from '../../../src/state/session';

const labels: Record<AutonomyLevel, string> = {
  0: 'Observe',
  1: 'Remind',
  2: 'Recommend',
  3: 'Prepare',
  4: 'Approve & execute',
  5: 'Autopilot',
};

const controls = [
  { domain: 'calendar', actionType: 'event_write', title: 'Calendar changes', maxForNow: 4 as AutonomyLevel },
  { domain: 'email', actionType: 'send', title: 'Email sending', maxForNow: 4 as AutonomyLevel },
  { domain: 'routine', actionType: 'schedule', title: 'Routine scheduling', maxForNow: 5 as AutonomyLevel },
] as const;

export default function AutonomyScreen() {
  const { graph, refresh } = useLifeGraph();
  const { accessToken } = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const change = async (domain: string, actionType: string, level: AutonomyLevel) => {
    if (!accessToken || busy) return;
    const key = `${domain}:${actionType}`;
    setBusy(key);
    setError(undefined);
    try {
      await setPermission(domain, actionType, level, accessToken);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update permission.');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Screen
      eyebrow="Permissions & Autonomy"
      title="APM never grants itself authority."
      subtitle="A subscription can make a capability available. You still decide whether APM may use it in each part of your life."
    >
      <Card tone="accent">
        <Flow steps={['Observe','Remind','Recommend','Prepare','Approve & execute','Autopilot']} />
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>Live domain permissions</SectionTitle>
      <View style={uiStyles.stack}>
        {controls.map((control) => {
          const key = `${control.domain}:${control.actionType}`;
          const permission = graph.permissions.find((item) => item.domain === control.domain && item.actionType === control.actionType);
          const current = (permission?.enabled ? permission.autonomyLevel : 0) as AutonomyLevel;
          const lower = Math.max(0, current - 1) as AutonomyLevel;
          const higher = Math.min(control.maxForNow, current + 1) as AutonomyLevel;
          return (
            <Card key={key}>
              <View style={uiStyles.row}>
                <CardTitle>{control.title}</CardTitle>
                <Pill>{labels[current]}</Pill>
              </View>
              <KeyValue label="Current level" value={`${current} · ${labels[current]}`} />
              <KeyValue label="Current product ceiling" value={`${control.maxForNow} · ${labels[control.maxForNow]}`} />
              <Body muted>Increasing a level is explicit. Level 4 still requires per-action approval; level 5 is standing authority within configured constraints.</Body>
              <Button label={busy === key ? 'Saving…' : `Reduce to ${labels[lower]}`} variant="secondary" onPress={() => void change(control.domain, control.actionType, lower)} />
              {current < control.maxForNow ? <Button label={busy === key ? 'Saving…' : `Increase to ${labels[higher]}`} onPress={() => void change(control.domain, control.actionType, higher)} /> : null}
            </Card>
          );
        })}
      </View>

      <Card tone="warning">
        <CardTitle>Locked rule</CardTitle>
        <Body>Repeated approvals, ordinary usage, or upgrading a subscription never silently raises a permission. Standing authority must be explicit and revocable.</Body>
      </Card>
    </Screen>
  );
}
