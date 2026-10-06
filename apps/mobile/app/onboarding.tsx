import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PillarName } from '@apm/domain';
import { Body, Button, Card, CardTitle, Label, Screen, uiStyles } from '../src/components/ui';
import { colors, radius, spacing } from '../src/theme';
import { useLifeGraph } from '../src/state/lifeGraph';

const pillars: { id: PillarName; label: string }[] = [
  { id: 'wealth', label: 'Wealth' },
  { id: 'body', label: 'Body' },
  { id: 'spirit', label: 'Spirit' },
  { id: 'execution', label: 'Execution' },
];

export default function OnboardingScreen() {
  const { completeOnboarding } = useLifeGraph();
  const [displayName, setDisplayName] = useState('');
  const [goal, setGoal] = useState('');
  const [season, setSeason] = useState('');
  const [becoming, setBecoming] = useState('');
  const [pillar, setPillar] = useState<PillarName>('wealth');

  const ready = displayName.trim().length > 0 && goal.trim().length > 4;

  const submit = () => {
    if (!ready) return;
    completeOnboarding({
      displayName,
      primaryGoal: goal,
      currentSeason: season,
      becoming,
      pillar,
    });
    router.replace('/(tabs)/today');
  };

  return (
    <Screen
      eyebrow="Build your system"
      title="Where are you going?"
      subtitle="Start with one outcome. APM will build the rest of the operating system around what actually matters."
    >
      <Card tone="accent">
        <CardTitle>Keep this lightweight.</CardTitle>
        <Body muted>You can refine everything later. We only need enough signal to create your first Life Graph and Today plan.</Body>
      </Card>

      <View style={uiStyles.stack}>
        <View style={styles.field}>
          <Label>What should APM call you?</Label>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            placeholderTextColor={colors.inkMuted}
            style={styles.input}
            autoCapitalize="words"
          />
        </View>

        <View style={styles.field}>
          <Label>What are you trying to make happen in the next 90 days?</Label>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="Close my first $1M in revenue"
            placeholderTextColor={colors.inkMuted}
            style={[styles.input, styles.multiline]}
            multiline
          />
        </View>

        <View style={styles.field}>
          <Label>Where does this goal live?</Label>
          <View style={styles.pillGrid}>
            {pillars.map((item) => {
              const active = pillar === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => setPillar(item.id)}
                  style={[styles.choice, active && styles.choiceActive]}
                >
                  <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Label>What season are you in right now? Optional</Label>
          <TextInput
            value={season}
            onChangeText={setSeason}
            placeholder="Building, recovering, accelerating, simplifying..."
            placeholderTextColor={colors.inkMuted}
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Label>Who are you becoming? Optional</Label>
          <TextInput
            value={becoming}
            onChangeText={setBecoming}
            placeholder="The kind of person who..."
            placeholderTextColor={colors.inkMuted}
            style={styles.input}
          />
        </View>
      </View>

      <Button label="Build my first APM" onPress={submit} />
      {!ready ? <Body muted>Enter your name and one concrete 90-day outcome to continue.</Body> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.ink,
    fontSize: 16,
  },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  choiceActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceText: { color: colors.ink, fontWeight: '700' },
  choiceTextActive: { color: '#FFFFFF' },
});
