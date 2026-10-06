import {
  Body,
  Button,
  Card,
  CardTitle,
  Screen,
  SectionTitle,
} from '../../../src/components/ui';

export default function ExportDeleteScreen() {
  return (
    <Screen
      eyebrow="Export & Delete"
      title="Your data should not be trapped."
      subtitle="These controls are visible from the beginning. Backend workflows will be implemented before claims are made in production."
    >
      <SectionTitle>Export</SectionTitle>
      <Card>
        <CardTitle>Export my APM data</CardTitle>
        <Body muted>
          The production export will include your Life Graph, permissions and meaningful APM activity in human- and machine-readable formats.
        </Body>
        <Button label="Export data · not wired yet" variant="secondary" onPress={() => {}} />
      </Card>

      <SectionTitle>Connections</SectionTitle>
      <Card>
        <CardTitle>Disconnect without deleting your account</CardTitle>
        <Body muted>External connections are managed independently from account deletion.</Body>
      </Card>

      <SectionTitle>Delete</SectionTitle>
      <Card tone="danger">
        <CardTitle>Delete my APM account and data</CardTitle>
        <Body>
          Production deletion will be an orchestrated workflow: stop sessions/actions, disconnect integrations, remove primary and derived state, handle caches/backups according to the published policy, and record non-sensitive completion evidence.
        </Body>
        <Button label="Delete account · not wired yet" variant="danger" onPress={() => {}} />
      </Card>
    </Screen>
  );
}
