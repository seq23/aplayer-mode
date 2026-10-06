import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PillarName } from '@apm/domain';
import { Body, Button, Card, CardTitle, Label, Screen, uiStyles } from '../src/components/ui';
import { colors, radius, spacing } from '../src/theme';
import { useLifeGraph } from '../src/state/lifeGraph';

const games = [
  'Building a business',
  'Parenting / caregiving',
  'Training / competing',
  'Studying / learning',
  'Career / leadership',
  'Creating / publishing',
  'Health / rebuilding',
  'Life transition',
  'Something else',
] as const;

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
  const [pillar, setPillar] = useState<PillarName>('execution');
  const [selectedGames, setSelectedGames] = useState<string[]>([]);

  const ready = displayName.trim().length > 0 && goal.trim().length > 4 && selectedGames.length > 0;

  const toggleGame = (game: string) => {
    setSelectedGames((current) =>
      current.includes(game) ? current.filter((item) => item !== game) : [...current, game],
    );
  };

  const submit = () => {
    if (!ready) return;
    completeOnboarding({
      displayName,
      roles: selectedGames,
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
      title="What game are you in?"
      subtitle="You can be in more than one. APM uses your roles, current season and goals to build the system around your actual life."
    >
      <Card tone="accent">
        <CardTitle>There is no single A Player template.</CardTitle>
        <Body muted>
          A parent, athlete, founder and student may need very different plans. The APM operating loop stays the same; the game changes.
        </Body>
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
          <Label>What games are you playing right now? Choose all that fit.</Label>
          <View style={styles.pillGrid}>
            {games.map((game) => {
              const active = selectedGames.includes(game);
              return (
                <Pressable
                  key={game}
                  onPress={() => toggleGame(game)}
                  style={[styles.choice, active && styles.choiceActive]}
                >
                  <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{game}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Label>What are you trying to make happen in the next 90 days?</Label>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="Ship my app, ace finals, finish my race, get family life under control..."
            placeholderTextColor={colors.inkMuted}
            style={[styles.input, styles.multiline]}
            multiline
          />
        </View>

        <View style={styles.field}>
          <Label>Which APM pillar most needs to carry this goal?</Label>
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
            placeholder="Building, recovering, competing, parenting, graduating, simplifying..."
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
      {!ready ? <Body muted>Enter your name, choose at least one game, and add one concrete 90-day outcome.</Body> : null}
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
