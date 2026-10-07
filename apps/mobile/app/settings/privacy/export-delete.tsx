import { useState } from 'react';
import {
  Body,
  Button,
  Card,
  CardTitle,
  ErrorState,
  Screen,
  SectionTitle,
  Toast,
} from '../../../src/components/ui';
import { exportMyData, requestDeletion } from '../../../src/api/apmApi';
import { router } from 'expo-router';
import { useSession } from '../../../src/state/session';
import { plainError } from '../../../src/api/errors';

export default function ExportDeleteScreen() {
  const { accessToken, signOut } = useSession();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'export' | 'delete'>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const runExport = async () => {
    if (!accessToken || busy) return;
    setBusy('export'); setError(undefined); setMessage(undefined);
    try {
      const result = await exportMyData(accessToken);
      setMessage(`Your export is ready (made ${new Date(result.export.generatedAt).toLocaleString()}). It holds your Life Graph and APM's activity record.`);
    } catch (cause) {
      setError(plainError(cause, 'The export did not finish. Try again.'));
    } finally { setBusy(undefined); }
  };

  const queueDeletion = async () => {
    if (!accessToken || busy) return;
    setBusy('delete'); setError(undefined); setMessage(undefined);
    try {
      await requestDeletion(accessToken);
      await signOut().catch(() => undefined);
      router.replace({ pathname: '/welcome', params: { deleted: '1' } });
    } catch (cause) {
      setError(plainError(cause, 'Deletion was not requested. Check your connection and try again.'));
    } finally { setBusy(undefined); }
  };

  return (
    <Screen
      eyebrow="Export & Delete"
      title="Your data should not be trapped."
      subtitle="Take a copy of everything APM holds, or delete your account and all of it."
    >
      {error ? <ErrorState message={error} /> : null}
      <Toast tone="success" message={message} />

      <SectionTitle>Export</SectionTitle>
      <Card>
        <CardTitle>Export my APM data</CardTitle>
        <Body muted>Your Life Graph and APM's activity record, made on the spot. No support ticket.</Body>
        <Button label={busy === 'export' ? 'Generating…' : 'Generate export'} variant="secondary" onPress={() => void runExport()} />
      </Card>

      <SectionTitle>Connections</SectionTitle>
      <Card>
        <CardTitle>Disconnect without deleting your account</CardTitle>
        <Body muted>You can disconnect a calendar or inbox from Privacy & AI → Connections and keep your account.</Body>
      </Card>

      <SectionTitle>Delete</SectionTitle>
      <Card tone="danger">
        <CardTitle>Delete my APM account and data</CardTitle>
        {!confirmDelete ? (
          <>
            <Body>Your account, your OS, your history and your connections are erased within 24 hours, and you are signed out.</Body>
            <Button label="Delete my account" variant="danger" onPress={() => setConfirmDelete(true)} />
          </>
        ) : (
          <>
            <Body>Delete everything? This cannot be undone. A store subscription is cancelled in the App Store or Google Play, not here.</Body>
            <Button label={busy === 'delete' ? 'Deleting…' : 'Delete everything'} variant="danger" onPress={() => void queueDeletion()} />
            <Button label="Keep my account" variant="secondary" onPress={() => setConfirmDelete(false)} />
          </>
        )}
      </Card>
    </Screen>
  );
}
