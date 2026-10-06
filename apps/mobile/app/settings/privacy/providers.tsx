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
import { providerFixtures } from '../../../src/fixtures/trust';

export default function ProvidersScreen() {
  return (
    <Screen
      eyebrow="AI transparency"
      title="Current AI processing routes."
      subtitle="This first implementation uses fixtures. Production will render this page from the live model registry so the disclosure matches actual routing."
    >
      <Card tone="accent">
        <View style={uiStyles.row}>
          <Pill tone="success">Private-data rule</Pill>
        </View>
        <CardTitle>Private APM data requires an approved no-training route.</CardTitle>
        <Body muted>For private life data, APM will prefer and generally require zero-data-retention processing under the model-routing policy.</Body>
      </Card>

      <SectionTitle>Registry preview</SectionTitle>
      <View style={uiStyles.stack}>
        {providerFixtures.map((provider) => (
          <Card key={provider.name}>
            <CardTitle>{provider.name}</CardTitle>
            <KeyValue label="Used for" value={provider.use} />
            <KeyValue label="Public-model training permitted" value={provider.training} />
            <KeyValue label="Retention" value={provider.retention} />
            <KeyValue label="Status" value={provider.status} />
          </Card>
        ))}
      </View>

      <Card tone="warning">
        <CardTitle>Why APM does not simply use “whatever model is free.”</CardTitle>
        <Body>
          Model and provider privacy policies differ. A $0 endpoint is only eligible for private data after its actual provider route passes APM privacy policy and quality evaluation.
        </Body>
      </Card>
    </Screen>
  );
}
