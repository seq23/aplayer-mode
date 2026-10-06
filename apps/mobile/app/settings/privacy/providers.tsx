import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { fetchModelRoutes } from '../../../src/api/apmApi';
import { useSession } from '../../../src/state/session';

interface RouteView {
  route_id?: string;
  model_id?: string;
  provider_id?: string;
  status?: string;
  cost_class?: string;
  capabilities?: string[];
  data_classes_allowed?: string[];
  training_allowed?: boolean;
  retention?: string;
  policy_notes?: string;
  last_policy_reviewed_at?: string;
  last_eval_run_at?: string | null;
}

export default function ProvidersScreen() {
  const { accessToken } = useSession();
  const [routes, setRoutes] = useState<RouteView[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    void fetchModelRoutes(accessToken)
      .then((result) => {
        if (active) setRoutes(result.routes as RouteView[]);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load the current model registry.');
      });
    return () => { active = false; };
  }, [accessToken]);

  return (
    <Screen
      eyebrow="AI transparency"
      title="Current AI processing routes."
      subtitle="This page is backed by APM's server model registry. Candidate and restricted routes are shown for transparency but cannot process private data unless they are explicitly approved."
    >
      <Card tone="accent">
        <View style={uiStyles.row}><Pill tone="success">Private-data rule</Pill></View>
        <CardTitle>Private APM data requires an approved no-training route.</CardTitle>
        <Body muted>For private-life data, the privacy gateway also requires zero-data-retention eligibility and disables unauthorized provider fallback.</Body>
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>Live model registry</SectionTitle>
      <View style={uiStyles.stack}>
        {routes.length ? routes.map((route) => (
          <Card key={route.route_id ?? `${route.provider_id}-${route.model_id}`}>
            <View style={uiStyles.row}>
              <CardTitle>{route.model_id ?? 'Unknown model'}</CardTitle>
              <Pill tone={route.status === 'approved' ? 'success' : undefined}>{route.status ?? 'unknown'}</Pill>
            </View>
            <KeyValue label="Provider route" value={route.provider_id ?? 'Unknown'} />
            <KeyValue label="Cost class" value={route.cost_class ?? 'Unknown'} />
            <KeyValue label="Capabilities" value={(route.capabilities ?? []).join(', ') || 'Not recorded'} />
            <KeyValue label="Private-data classes" value={(route.data_classes_allowed ?? []).join(', ') || 'None'} />
            <KeyValue label="Public-model training permitted" value={route.training_allowed ? 'Yes' : 'No'} />
            <KeyValue label="Retention" value={route.retention ?? 'Unknown'} />
            <KeyValue label="Last privacy review" value={route.last_policy_reviewed_at ?? 'Not recorded'} />
            <KeyValue label="Last quality eval" value={route.last_eval_run_at ?? 'Not yet evaluated'} />
            {route.policy_notes ? <Body muted>{route.policy_notes}</Body> : null}
          </Card>
        )) : <Card><Body muted>No routes are currently visible to this account.</Body></Card>}
      </View>

      <Card tone="warning">
        <CardTitle>$0 does not override privacy.</CardTitle>
        <Body>A free endpoint becomes eligible only after its exact provider route passes APM privacy policy and task-specific quality evaluation.</Body>
      </Card>
    </Screen>
  );
}
