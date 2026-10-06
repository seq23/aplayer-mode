import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { connectionFixtures } from '../../../src/fixtures/trust';

export default function ConnectionsScreen() {
  return (
    <Screen
      eyebrow="Connections"
      title="You choose what APM can see."
      subtitle="Before APM asks for an external account, it should explain why it wants access and what that access enables."
    >
      <Card tone="accent">
        <CardTitle>No external accounts are connected in this scaffold.</CardTitle>
        <Body muted>The cards below are the product experience we will wire to real OAuth and scope state later.</Body>
      </Card>

      <SectionTitle>Connected services</SectionTitle>
      <View style={uiStyles.stack}>
        {connectionFixtures.map((connection) => (
          <Card key={connection.name}>
            <View style={uiStyles.row}>
              <CardTitle>{connection.name}</CardTitle>
              <Pill>{connection.state}</Pill>
            </View>
            <KeyValue label="APM can currently" value={connection.can} />
            <KeyValue label="APM cannot currently" value={connection.cannot} />
            <Button label={`Why connect ${connection.name}?`} variant="secondary" onPress={() => {}} />
          </Card>
        ))}
      </View>

      <Card tone="warning">
        <CardTitle>Least privilege first.</CardTitle>
        <Body>APM should request the narrowest useful OAuth scopes and explain new capabilities before requesting broader access.</Body>
      </Card>
    </Screen>
  );
}
