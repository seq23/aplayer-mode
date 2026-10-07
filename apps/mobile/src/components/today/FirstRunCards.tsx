import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { LifeGraphSnapshot, OperatingModeKey } from '@apm/domain';
import {
  buildIntakeProfile,
  calendarDateInTimezone,
  coachingModeChips,
  deferredForToday,
  formatPillarRollUp,
  generateBedRoutine,
  practiceDueOn,
  practicesFromProfile,
  questionById,
  rollUpPillars,
  synthesizeProfile,
  weekdayFromName,
  type AnswerValue,
  type PillarReviewEntry,
} from '@apm/planning';
import { Body, Button, Card, CardTitle, Label } from '../ui';
import { BedRoutineCard } from '../intake/Interstitials';
import { QuestionView } from '../intake/QuestionView';
import { Chip, Muted, intakeStyles } from '../intake/primitives';
import { useIntake } from '../../intake/store';
import { useLifeGraph } from '../../state/lifeGraph';
import { useSession } from '../../state/session';
import { updateIntakeProfile } from '../../api/apmApi';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function today(graph: LifeGraphSnapshot): string {
  return calendarDateInTimezone(new Date(), graph.identity.timezone);
}

/** Day N of the install (Day 1 = install day). */
export function installDay(graph: LifeGraphSnapshot): number {
  const start = graph.personalOS?.stabilizationStartedAt?.slice(0, 10);
  if (!start) return 1;
  return Math.floor((Date.parse(`${today(graph)}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** "Your OS is only on this phone. Save it" until she saves an account (docs/34 §5 9a). */
export function SaveAccountBanner() {
  const { isAnonymous } = useSession();
  if (!isAnonymous) return null;
  return (
    <Card tone="warning">
      <CardTitle>Your OS is only on this phone.</CardTitle>
      <Body muted>Save it to an account so a lost phone never loses it. No passwords.</Body>
      <Button label="Save it" onPress={() => router.push('/account')} />
    </Card>
  );
}

/** Morning step 1 for "getting out of bed is hard": the generated routine, on Today. */
export function BedRoutineToday({ graph }: { graph: LifeGraphSnapshot }) {
  const profile = graph.personalOS?.intakeProfile;
  if (!profile?.bedRoutine) return null;
  const routine = generateBedRoutine('yes', profile.bedRoutine.gentle ? 'yes' : 'no');
  return routine ? <BedRoutineCard moves={routine.moves} gentle={routine.gentle} note={routine.note} /> : null;
}

/** Mind and Spirit practices due today that are not daily floors (weekly reflection, therapy, service…). */
export function PracticesToday({ graph }: { graph: LifeGraphSnapshot }) {
  const profile = graph.personalOS?.intakeProfile;
  if (!profile) return null;
  const date = today(graph);
  const reviewDay = weekdayFromName(graph.personalOS?.weeklyCadence.reviewDay) ?? 0;
  const active = new Set(graph.pillarSettings.filter((s) => s.active).map((s) => s.name));
  const due = practicesFromProfile(profile, date, graph.personalOS?.stabilizationStartedAt?.slice(0, 10) ?? date)
    .filter((p) => p.cadence !== 'daily' && active.has(p.area) && practiceDueOn(p.cadence, date, reviewDay));
  if (!due.length) return null;
  return (
    <Card>
      <Label>Also on today, already written for you</Label>
      {due.map((p) => (
        <View key={p.key} style={intakeStyles.stack}>
          <CardTitle>{p.title}</CardTitle>
          {p.steps.map((step) => <Body key={step} muted>{`• ${step}`}</Body>)}
          <Muted>{`Hard day: ${p.floor.title}`}</Muted>
        </View>
      ))}
    </Card>
  );
}

/** One-tap coaching modes (docs/34 §9), wired to POST /v1/methodology/mode. */
export function CoachingModeChips({ graph, activeMode }: { graph: LifeGraphSnapshot; activeMode: OperatingModeKey }) {
  const { setOperatingMode } = useLifeGraph();
  const [error, setError] = useState<string>();
  const profile = graph.personalOS?.intakeProfile;
  const chips = coachingModeChips({ games: profile?.games ?? graph.roles.map((r) => r.name.toLowerCase()), deadlines: profile?.deadlines ?? [] });
  const focus = graph.goals.find((goal) => goal.id === graph.personalOS?.foregroundGoalId)?.title ?? 'The foreground task';
  const pick = async (mode: (typeof chips)[number]['mode']) => {
    setError(undefined);
    try {
      if (activeMode === mode) await setOperatingMode({ action: 'exit' });
      else if (mode === 'sprint') await setOperatingMode({ action: 'enter', mode: 'sprint', days: 3 });
      else if (mode === 'deep_work') await setOperatingMode({ action: 'enter', mode: 'deep_work', minutes: 90, focus: focus.slice(0, 200) });
      else await setOperatingMode({ action: 'enter', mode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/ \(\d{3}\).*$/, '') : 'That mode could not start.');
    }
  };
  return (
    <Card>
      <Label>Coaching modes · one tap, any time</Label>
      <View style={intakeStyles.chips}>
        {chips.map((chip) => <Chip key={chip.mode} label={chip.label} selected={activeMode === chip.mode} onPress={() => void pick(chip.mode)} />)}
      </View>
      {chips.map((chip) => <Muted key={chip.mode}>{`${chip.label}: ${chip.when}`}</Muted>)}
      {error ? <Text style={intakeStyles.why}>{error}</Text> : null}
    </Card>
  );
}

/** "2 quick taps to sharpen your plan": quick-start questions, ≤ 2 a day, never Day 1 or a light day. */
export function QuickTaps({ graph }: { graph: LifeGraphSnapshot }) {
  const { draft, answer, patch } = useIntake();
  const { accessToken } = useSession();
  const { applyTodayState } = useLifeGraph();
  const [held, setHeld] = useState(false);
  if (!graph.personalOS?.intakeProfile?.quickStart) return null;
  const date = today(graph);
  const day = installDay(graph);
  const weekday = WEEKDAY_SHORT[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
  const lightDays = graph.personalOS.weeklyCadence.lightDays ?? [];
  const lightDay = lightDays.some((d) => d.slice(0, 3).toLowerCase() === weekday.toLowerCase());
  const askedToday = draft.answers._deferred_day === date ? Number(draft.answers._deferred_count ?? 0) : 0;
  const ids = deferredForToday(draft.answers, { dayNumber: day, lightDay, askedToday });
  if (!ids.length) return null;

  const sync = async (answers: Record<string, AnswerValue | undefined>) => {
    if (!accessToken) return;
    const s = synthesizeProfile(answers, { startDate: date });
    const profile = buildIntakeProfile(answers, 'quick', s);
    try {
      const state = await updateIntakeProfile(profile, accessToken);
      applyTodayState(state);
      setHeld(state.held === 'week_one');
    } catch { /* kept in the draft; sent again with the next answer */ }
  };

  return (
    <Card tone="accent">
      <Label>2 quick taps to sharpen your plan</Label>
      {ids.map((id) => {
        const q = questionById(id);
        if (!q) return null;
        return (
          <QuestionView key={id} question={q} answers={draft.answers} screenReader onAutoAdvance={() => undefined}
            onSet={(qid, value) => {
              answer(qid, value);
              patch({ _deferred_day: date, _deferred_count: askedToday + 1 });
              const next = { ...draft.answers, [qid]: value };
              // Body safety applies at once; the rest becomes the profile from Day 8 (Week-1 rules).
              if (qid === 'clinician_flag' || day >= 8) void sync(next);
            }}
          />
        );
      })}
      {held || day < 8 ? <Muted>Saved. Week 1 keeps your OS steady: these answers sharpen it on Day 8.</Muted> : null}
    </Card>
  );
}

/** "Mind ✓ Body ✓ Spirit –": the day's area review rolled up to the three pillars. */
export function PillarRollUpLine({ graph, review, recovery }: { graph: LifeGraphSnapshot; review: PillarReviewEntry[]; recovery: boolean }) {
  const critical = graph.pillarSettings.filter((s) => s.active && s.critical).map((s) => s.name);
  const enabled = graph.personalOS?.pillarsEnabled;
  return <Body>{formatPillarRollUp(rollUpPillars(review, critical, { recovery, ...(enabled ? { enabled } : {}) }))}</Body>;
}
