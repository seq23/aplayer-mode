import { View } from 'react-native';
import {
  CARRY_DO,
  bedRoutineFor,
  chosenGoal,
  compileMorning,
  gameLabel,
  type IntakeAnswers,
  type InterstitialDef,
} from '@apm/planning';
import { PLAN_PRICES } from '@apm/policy';
import { Body, Card, CardTitle, Fill, Label, Pill, QuestionTitle, Row } from '../ui';
import { intakeStyles } from './primitives';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const arr = (a: IntakeAnswers, id: string) => (Array.isArray(a[id]) ? (a[id] as string[]) : []);

/** Playback interstitials (docs/34 §10): each one shows her own answers back, and what APM now does. */
export function Interstitial({ it, answers }: { it: InterstitialDef; answers: IntakeAnswers }) {
  const heading = <QuestionTitle>{it.title}</QuestionTitle>;
  if (it.kind === 'heard') {
    return (
      <View style={intakeStyles.stack}>
        {heading}
        <Card>
          <Label>Your games</Label>
          <Body>{arr(answers, 'games').map(gameLabel).join(' + ') || '—'}</Body>
          {answers.foreground ? <Body muted>{`Most push for 90 days: ${gameLabel(String(answers.foreground))}`}</Body> : null}
        </Card>
        <Card>
          <CardTitle>Moving out of your head, and what APM does with it</CardTitle>
          {arr(answers, 'carry').map((key) => {
            const carry = CARRY_DO[key];
            if (!carry) return <Body key={key}>{`• ${key}`}</Body>;
            const [label, does, plan, needs] = carry;
            return <Body key={key}>{`• ${label}: ${does} (${PLAN_PRICES[plan].displayName}${needs ? ` + ${needs}` : ''})`}</Body>;
          })}
        </Card>
        <Body>{`Your head is at ${answers.load ?? 7}/10. We'll ask again on Day 5.`}</Body>
      </View>
    );
  }
  if (it.kind === 'plan') {
    const goal = chosenGoal(answers);
    return (
      <View style={intakeStyles.stack}>
        {heading}
        <Card tone="accent"><CardTitle>{`${goal?.label ?? 'Your goal'}${goal?.size ? ` · ${answers.goal_size ?? goal.size.def} ${goal.size.unit}` : ''}`}</CardTitle></Card>
        <Card>
          <Body>{`Days 1 to 30, Foundation: ${answers.first_step ?? 'your first step'} and keep it going`}</Body>
          <Body>Days 31 to 60, Build: make it repeatable</Body>
          <Body>Days 61 to 90, Lock: lock it in, then decide: Promote, Maintain or Park</Body>
        </Card>
        <Body muted>You won't plan any of this. APM turns it into one step a day.</Body>
      </View>
    );
  }
  if (it.kind === 'laws') {
    const miss: Record<string, string> = {
      bounce: 'You bounce back fast. APM keeps it that way.',
      two_three: 'You said a miss costs you 2 or 3 days. APM catches you at one.',
      week: 'You said a miss can cost a week. Next time, the next day shrinks to one small thing.',
      quit: 'You said you usually quit. This system is built so a miss never ends it.',
    };
    return (
      <View style={intakeStyles.stack}>
        {heading}
        {answers.after_miss ? <Body>{miss[String(answers.after_miss)] ?? ''}</Body> : null}
        <Card>
          <Body>Never Miss Twice. One miss is data.</Body>
          <Body>No Catch-Up. You never owe yesterday anything.</Body>
          <Body>Minimum Viable Day. On a 2/10 day: one small thing, close the day. It counts.</Body>
          <Body>Zeros are allowed. Quitting is not.</Body>
        </Card>
      </View>
    );
  }
  if (it.kind === 'week') {
    return (
      <View style={intakeStyles.stack}>
        {heading}
        <Card>
          {WEEK.map((day) => (
            <View key={day} accessible accessibilityLabel={`${day}: ${arr(answers, 'heavy').includes(day) ? 'heavy' : arr(answers, 'light').includes(day) ? 'light' : 'normal'}`}>
              <Row gap="sm">
                <Fill><Body strong>{day}</Body></Fill>
                <Pill tone={arr(answers, 'heavy').includes(day) ? 'warning' : arr(answers, 'light').includes(day) ? 'success' : 'neutral'}>{arr(answers, 'heavy').includes(day) ? 'Heavy' : arr(answers, 'light').includes(day) ? 'Light' : 'Normal'}</Pill>
                {answers.review === day ? <Pill tone="accent">Review</Pill> : null}
                {answers.recovery === day ? <Pill tone="accent">Recovery</Pill> : null}
              </Row>
            </View>
          ))}
        </Card>
        <Body muted>Big tasks land on heavy days, light days stay light, and the review shows up on its own.</Body>
      </View>
    );
  }
  return (
    <View style={intakeStyles.stack}>
      {heading}
      <MorningCard answers={answers} />
      <Body muted>Max 5 physical steps. Your launch ramp, not another ritual.</Body>
    </View>
  );
}

/** The compiled morning sequence, with the in-bed routine spelled out when it is on. */
export function MorningCard({ answers, compact = false }: { answers: IntakeAnswers; compact?: boolean }) {
  const steps = compileMorning(answers);
  const routine = bedRoutineFor(answers);
  return (
    <View style={intakeStyles.stack}>
      <Card>{steps.map((step, i) => <Body key={`${i}-${step}`}>{`${i + 1}. ${step}`}</Body>)}</Card>
      {routine && !compact ? <BedRoutineCard moves={routine.moves} gentle={routine.gentle} note={routine.note} /> : null}
    </View>
  );
}

export function BedRoutineCard({ moves, gentle, note }: { moves: ReadonlyArray<{ minutes: number; move: string }>; gentle: boolean; note: string }) {
  return (
    <Card tone="accent">
      <CardTitle>{`Your 10-minute in-bed routine${gentle ? ' (gentle range)' : ''}`}</CardTitle>
      <Body muted>Pilates-style, no equipment.</Body>
      {moves.map((m, i) => <Body key={m.move}>{`${i + 1}. ${m.move} · ${m.minutes} min`}</Body>)}
      <Body muted>{note}</Body>
    </Card>
  );
}
