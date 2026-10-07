import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ActiveTrackKey, PillarName } from '@apm/domain';
import { Body, Button, Card, CardTitle, Label, Screen, uiStyles } from '../src/components/ui';
import { colors, radius, spacing } from '../src/theme';
import { useLifeGraph } from '../src/state/lifeGraph';
import { useSession } from '../src/state/session';

const games = [
  'Building a business','Parenting / caregiving','Training / competing','Studying / learning',
  'Career / leadership','Creating / publishing','Health / rebuilding','Life transition','Something else',
] as const;
const pillars: { id: PillarName; label: string }[] = [
  { id: 'wealth', label: 'Wealth' }, { id: 'body', label: 'Body' }, { id: 'spirit', label: 'Spirit' }, { id: 'execution', label: 'Execution' }, { id: 'family', label: 'Family' },
];
const tracks: { id: ActiveTrackKey; label: string; description: string }[] = [
  { id: 'operator_discipline', label: 'Operator Discipline', description: 'Follow through and renegotiate less.' },
  { id: 'strategic_patience', label: 'Strategic Patience', description: 'Do not pivot before evidence earns the pivot.' },
  { id: 'resilience', label: 'Resilience', description: 'Treat recovery as execution and protect continuity during volatility.' },
  { id: 'billionaire_mindset', label: 'Billionaire Mindset', description: 'Ownership, leverage, compounding and asymmetric upside.' },
  { id: 'body_foundation', label: 'Body Foundation', description: 'Small tracked body behaviours at a safe pace. Never diet or medical advice.' },
  { id: 'wealth_foundation', label: 'Wealth Foundation', description: 'Pay yourself first, one debt at a time, buffer before bets. Never product advice.' },
  { id: 'home_front', label: 'Home Front', description: 'Family blocks are fixed commitments; conflicts are decided ahead of time.' },
];

const TOTAL_STEPS = 20;
const splitList = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

function goalPrompt(roles: string[]) {
  const selected = roles.join(' ').toLowerCase();
  if (/training|competing/.test(selected)) return 'What are you training for, and by when?';
  if (/parenting|caregiving/.test(selected)) return 'What would make family life feel meaningfully better or more under control in the next 90 days?';
  if (/studying|learning/.test(selected)) return 'What academic or learning outcome matters most right now?';
  if (/creating|publishing/.test(selected)) return 'What are you trying to ship, publish, or build in the next 90 days?';
  if (/health|rebuilding/.test(selected)) return 'What does meaningful progress look like in this season?';
  if (/transition/.test(selected)) return 'What needs to become true for this transition to feel successful?';
  if (/business|career|leadership/.test(selected)) return 'What business, career, or leadership outcome matters most in the next 90 days?';
  return 'What are you trying to make happen in the next 90 days?';
}

export default function OnboardingScreen() {
  const { status } = useSession();
  const { completeMethodologyIntake, isDurable, syncError } = useLifeGraph();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [selectedGames, setSelectedGames] = useState<string[]>([]);
  const [goal, setGoal] = useState('');
  const [goalTargetDate, setGoalTargetDate] = useState('');
  const [firstNextAction, setFirstNextAction] = useState('');
  const [pillar, setPillar] = useState<PillarName>('execution');
  const [season, setSeason] = useState('');
  const [becoming, setBecoming] = useState('');
  const [northStar, setNorthStar] = useState('');
  const [valuesText, setValuesText] = useState('');
  const [nonNegotiablesText, setNonNegotiablesText] = useState('');
  const [failurePatternsText, setFailurePatternsText] = useState('');
  const [bodyContext, setBodyContext] = useState('');
  const [workMoneyContext, setWorkMoneyContext] = useState('');
  const [mindSpiritLearningContext, setMindSpiritLearningContext] = useState('');
  const [heavyDays, setHeavyDays] = useState('');
  const [lightDays, setLightDays] = useState('');
  const [reviewDay, setReviewDay] = useState('');
  const [recoveryDay, setRecoveryDay] = useState('');
  const [criticalPillars, setCriticalPillars] = useState<PillarName[]>(['execution']);
  const [minimumFloors, setMinimumFloors] = useState<Partial<Record<PillarName, string>>>({});
  const [firmness, setFirmness] = useState<'gentle' | 'direct' | 'high_pressure'>('direct');
  const [dayStart, setDayStart] = useState<'guided' | 'hard'>('guided');
  const [morningSequenceText, setMorningSequenceText] = useState('');
  const [schedulingPreference, setSchedulingPreference] = useState<'strict_blocks' | 'loose_dayparts' | 'ordered_stack'>('ordered_stack');
  const [hardBoundariesText, setHardBoundariesText] = useState('');
  const [selectedTracks, setSelectedTracks] = useState<ActiveTrackKey[]>(['operator_discipline']);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  useEffect(() => { if (status === 'signed_out') router.replace('/sign-in'); }, [status]);
  useEffect(() => {
    const business = selectedGames.some((game) => /business|career|leadership/i.test(game));
    if (business) setSelectedTracks((current) => Array.from(new Set<ActiveTrackKey>([...current, 'billionaire_mindset', 'strategic_patience'])));
  }, [selectedGames]);
  useEffect(() => {
    if (/burnout|all.?or.?nothing|crash|overwhelm|recovery/i.test(failurePatternsText)) {
      setSelectedTracks((current) => Array.from(new Set<ActiveTrackKey>([...current, 'resilience'])));
    }
  }, [failurePatternsText]);

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const toggleGame = (game: string) => setSelectedGames((current) => current.includes(game) ? current.filter((item) => item !== game) : [...current, game]);
  const togglePillar = (id: PillarName) => setCriticalPillars((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleTrack = (id: ActiveTrackKey) => setSelectedTracks((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const canContinue = step === 0 ? displayName.trim().length > 0 : step === 1 ? selectedGames.length > 0 : step === 2 ? goal.trim().length > 4 : step === 3 ? firstNextAction.trim().length > 2 : step === 13 ? criticalPillars.length > 0 : true;

  const submit = async () => {
    if (!isDurable || busy) return;
    setBusy(true); setSubmitError(undefined);
    try {
      await completeMethodologyIntake({
        displayName, roles: selectedGames, primaryGoal: goal, goalTargetDate: goalTargetDate.trim() || undefined,
        firstNextAction, pillar, currentSeason: season || undefined, becoming: becoming || undefined, timezone,
        northStar: northStar || undefined, values: splitList(valuesText), nonNegotiables: splitList(nonNegotiablesText),
        failurePatterns: splitList(failurePatternsText), bodyContext: bodyContext || undefined, workMoneyContext: workMoneyContext || undefined,
        mindSpiritLearningContext: mindSpiritLearningContext || undefined,
        weeklyCadence: { heavyDays: splitList(heavyDays), lightDays: splitList(lightDays), reviewDay: reviewDay || undefined, recoveryDay: recoveryDay || undefined },
        coachingStyle: { firmness }, accountability: { dayStart, coachingReminderAfterDays: 7 }, criticalPillars, minimumFloors,
        trackKeys: selectedTracks, activeMode: 'standard', morningSequence: splitList(morningSequenceText).slice(0, 5), schedulingPreference,
        hardBoundaries: splitList(hardBoundariesText), scoringConfig: { enabled: true, showSevenDaySnapshot: true },
        foregroundProjectName: goal, foregroundProjectObjective: goal, reviewGateDays: 30,
      });
      router.replace('/(tabs)/today');
    } catch (error) { setSubmitError(error instanceof Error ? error.message : 'Unable to install your Personal OS.'); }
    finally { setBusy(false); }
  };

  const field = (value: string, onChangeText: (value: string) => void, placeholder: string, multiline = true) => (
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.inkMuted} style={[styles.input, multiline && styles.multiline]} multiline={multiline} />
  );
  const choice = (label: string, active: boolean, onPress: () => void, description?: string) => (
    <Pressable onPress={onPress} style={[styles.choice, active && styles.choiceActive]}>
      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text>
      {description ? <Text style={[styles.choiceDescription, active && styles.choiceTextActive]}>{description}</Text> : null}
    </Pressable>
  );

  const content = (() => {
    switch (step) {
      case 0: return <>{field(displayName, setDisplayName, 'Your name', false)}</>;
      case 1: return <View style={styles.pillGrid}>{games.map((game) => <View key={game}>{choice(game, selectedGames.includes(game), () => toggleGame(game))}</View>)}</View>;
      case 2: return <>{field(goal, setGoal, 'Make the outcome concrete...')}<Label>Target date — optional (YYYY-MM-DD)</Label>{field(goalTargetDate, setGoalTargetDate, '2027-01-15', false)}<Label>Which pillar most carries this goal?</Label><View style={styles.pillGrid}>{pillars.map((item) => <View key={item.id}>{choice(item.label, pillar === item.id, () => setPillar(item.id))}</View>)}</View></>;
      case 3: return <>{field(firstNextAction, setFirstNextAction, 'A physical action you could start without further planning...')}</>;
      case 4: return <>{field(season, setSeason, 'Building, competing, caregiving, recovering, graduating, rebuilding...')}</>;
      case 5: return <>{field(becoming, setBecoming, 'The kind of person who...')}</>;
      case 6: return <>{field(northStar, setNorthStar, 'The larger outcome or direction this season should serve...')}</>;
      case 7: return <>{field(valuesText, setValuesText, 'Integrity, family, freedom, mastery... Separate with commas or new lines.')}</>;
      case 8: return <>{field(nonNegotiablesText, setNonNegotiablesText, 'What cannot be sacrificed or crossed?')}</>;
      case 9: return <>{field(failurePatternsText, setFailurePatternsText, 'Perfectionism, avoidance, burnout, overcommitting, quitting after a miss...')}</>;
      case 10: return <>{field(bodyContext, setBodyContext, 'Sleep, movement, food, recovery or health routines APM should respect. Optional.')}</>;
      case 11: return <>{field(workMoneyContext, setWorkMoneyContext, 'Primary work, income engines, business priorities or what counts as real work. Optional.')}</>;
      case 12: return <>{field(mindSpiritLearningContext, setMindSpiritLearningContext, 'Practices, learning priorities, reflection or spiritual routines. Optional.')}</>;
      case 13: return <><View style={styles.pillGrid}>{pillars.map((item) => <View key={item.id}>{choice(item.label, criticalPillars.includes(item.id), () => togglePillar(item.id))}</View>)}</View>{criticalPillars.map((item) => <View key={item} style={styles.field}><Label>{item.charAt(0).toUpperCase() + item.slice(1)} minimum on a hard day</Label>{field(minimumFloors[item] ?? '', (value) => setMinimumFloors((current) => ({ ...current, [item]: value })), 'The smallest version that still counts...', false)}</View>)}</>;
      case 14: return <View style={uiStyles.stack}><Label>Weekly cadence — optional</Label>{field(heavyDays, setHeavyDays, 'Heavy days: Monday, Tuesday', false)}{field(lightDays, setLightDays, 'Light days: Friday, Sunday', false)}{field(reviewDay, setReviewDay, 'Review day: Friday', false)}{field(recoveryDay, setRecoveryDay, 'Recovery day: Sunday', false)}</View>;
      case 15: return <View style={uiStyles.stack}><Label>How should APM coach you?</Label>{choice('Gentle', firmness === 'gentle', () => setFirmness('gentle'), 'Supportive and low-pressure.')}{choice('Direct', firmness === 'direct', () => setFirmness('direct'), 'Clear, concise and candid. Default.')}{choice('High-pressure when asked', firmness === 'high_pressure', () => setFirmness('high_pressure'), 'Forceful challenge without shame or coercion.')}<Label>How should your day start?</Label>{choice('Guided Start', dayStart === 'guided', () => setDayStart('guided'), 'See the agenda; begin with the opening action.')}{choice('Hard Start', dayStart === 'hard', () => setDayStart('hard'), 'Only the opening action is surfaced until you confirm it.')}</View>;
      case 16: return <><Body muted>Up to five physical steps. This is your launch ramp, not another productivity ritual.</Body>{field(morningSequenceText, setMorningSequenceText, 'Example:\n30 seconds of movement\n3 slow breaths\nDrink water\nStep into sunlight\nOpen the first task')}</>;
      case 17: return <View style={uiStyles.stack}>{choice('Strict time blocks', schedulingPreference === 'strict_blocks', () => setSchedulingPreference('strict_blocks'), 'APM should prefer explicit start/end times.')}{choice('Loose dayparts', schedulingPreference === 'loose_dayparts', () => setSchedulingPreference('loose_dayparts'), 'Morning / afternoon / evening is enough structure.')}{choice('Ordered stack', schedulingPreference === 'ordered_stack', () => setSchedulingPreference('ordered_stack'), 'Tell me what comes next without over-scheduling.')}</View>;
      case 18: return <><Body muted>Protect the rules reality should not casually override.</Body>{field(hardBoundariesText, setHardBoundariesText, 'No meetings during pickup\nNo side projects on weekdays\nProtect sleep after 10 PM...')}</>;
      case 19: return <><Body muted>Tracks are background lenses, not more tasks. Choose only what should shape decisions over time.</Body><View style={uiStyles.stack}>{tracks.map((item) => <View key={item.id}>{choice(item.label, selectedTracks.includes(item.id), () => toggleTrack(item.id), item.description)}</View>)}</View><Card tone="accent"><CardTitle>Your APM will install</CardTitle><Body>{selectedGames.join(' + ')}</Body><Body muted>Primary goal: {goal}</Body><Body muted>Critical pillars: {criticalPillars.join(', ')}</Body><Body muted>Morning launch: {splitList(morningSequenceText).slice(0, 5).join(' → ') || 'APM can help you define this later.'}</Body><Body muted>Tracks: {selectedTracks.length ? selectedTracks.map((id) => tracks.find((track) => track.id === id)?.label ?? id).join(', ') : 'None'}</Body><Body muted>Core laws: Never Miss Twice · Continuity &gt; Intensity · No Catch-Up · No Mid-Day Negotiation · Zeros Allowed · MVD</Body></Card></>;
      default: return null;
    }
  })();

  const titles = [
    'What should APM call you?','What game are you in?',goalPrompt(selectedGames),'What is the next physical action?','What season are you in right now?','Who are you becoming?','What is the bigger North Star?','What values should APM protect?','What is non-negotiable?','What patterns usually knock you off course?','What should APM know about your Body?','What should APM know about work and money?','What should APM know about mind, spirit or learning?','Which pillars are critical?','What does your week normally look like?','How should APM hold you accountable?','Build your Morning Sequence','How should APM structure your day?','What boundaries should APM protect?','Which long-horizon tracks should run in the background?',
  ];

  return (
    <Screen eyebrow={`Build your Personal OS · ${step + 1}/${TOTAL_STEPS}`} title={titles[step] ?? 'Build your A Player Mode'} subtitle={step === 1 ? 'Choose more than one. Parent + entrepreneur + athlete is one life, not three products.' : 'One question at a time. Optional answers can be skipped; your Personal OS can evolve later.'}>
      {step === 0 ? <Card tone="accent"><CardTitle>Whatever game you're in, get into A Player Mode.</CardTitle><Body muted>You decide what game you're playing. A Player Mode helps you play it like an A-player.</Body></Card> : null}
      {!isDurable ? <Card tone="warning"><CardTitle>Your private account is not connected to the APM API yet.</CardTitle><Body muted>{syncError ?? 'This build cannot persist your Personal OS yet, so installation is paused instead of pretending it saved.'}</Body></Card> : null}
      <View style={uiStyles.stack}>{content}</View>
      {submitError ? <Card tone="danger"><Body>{submitError}</Body></Card> : null}
      <View style={styles.navRow}>{step > 0 ? <Button label="Back" variant="secondary" onPress={() => setStep((current) => Math.max(0, current - 1))} /> : null}{step < TOTAL_STEPS - 1 ? <Button label="Continue" onPress={() => canContinue && setStep((current) => Math.min(TOTAL_STEPS - 1, current + 1))} /> : <Button label={busy ? 'Installing your APM…' : 'Approve & install my APM'} onPress={() => void submit()} />}</View>
      {!canContinue ? <Body muted>Answer this question to continue.</Body> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 14, color: colors.ink, fontSize: 16 },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  choiceActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceText: { color: colors.ink, fontWeight: '700' },
  choiceDescription: { color: colors.inkMuted, fontSize: 13, lineHeight: 18 },
  choiceTextActive: { color: '#FFFFFF' },
  navRow: { gap: spacing.sm },
});
