import { useState } from 'react';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Screen,
  SectionTitle,
} from '../../../src/components/ui';
import { exportMyData, requestDeletion } from '../../../src/api/apmApi';
import { useSession } from '../../../src/state/session';

export default function ExportDeleteScreen() {
  const { accessToken } = useSession();
  const [busy, setBusy] = useState<'export' | 'delete'>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const runExport = async () => {
    if (!accessToken || busy) return;
    setBusy('export'); setError(undefined); setMessage(undefined);
    try {
      const result = await exportMyData(accessToken);
      setMessage(`Export ${result.job.id} is ${result.job.status}. Snapshot generated ${result.export.generatedAt}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create export.');
    } finally { setBusy(undefined); }
  };

  const queueDeletion = async () => {
    if (!accessToken || busy) return;
    setBusy('delete'); setError(undefined); setMessage(undefined);
    try {
      const result = await requestDeletion(accessToken);
      setMessage(`Deletion request ${result.job.id} is ${result.job.status}. ${result.note}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to request deletion.');
    } finally { setBusy(undefined); }
  };

  return (
    <Screen
      eyebrow="Export & Delete"
      title="Your data should not be trapped."
      subtitle="Export is available through the authenticated APM API. Account deletion is deliberately orchestrated and is not represented as finished until the privileged deletion worker verifies every lifecycle step."
    >
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      {message ? <Card tone="accent"><KeyValue label="Request status" value={message} /></Card> : null}

      <SectionTitle>Export</SectionTitle>
      <Card>
        <CardTitle>Export my APM data</CardTitle>
        <Body muted>The export contains your current Life Graph and meaningful APM activity. It is generated through your authenticated user boundary rather than a support ticket.</Body>
        <Button label={busy === 'export' ? 'Generating…' : 'Generate export'} variant="secondary" onPress={() => void runExport()} />
      </Card>

      <SectionTitle>Connections</SectionTitle>
      <Card>
        <CardTitle>Disconnect without deleting your account</CardTitle>
        <Body muted>External connections remain independently manageable from the Connections page. Deleting your APM account is not required to revoke a provider connection.</Body>
      </Card>

      <SectionTitle>Delete</SectionTitle>
      <Card tone="danger">
        <CardTitle>Request deletion of my APM account and data</CardTitle>
        <Body>APM queues an auditable deletion job. Production completion must stop sessions/actions, disconnect integrations, remove primary and derived state, apply published retention exceptions, and record non-sensitive completion evidence.</Body>
        <Button label={busy === 'delete' ? 'Requesting…' : 'Request account deletion'} variant="danger" onPress={() => void queueDeletion()} />
      </Card>
    </Screen>
  );
}
