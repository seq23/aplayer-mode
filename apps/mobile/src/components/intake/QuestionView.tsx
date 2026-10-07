import { useEffect, useRef, useState } from 'react';
import { Platform, View, findNodeHandle, AccessibilityInfo } from 'react-native';
import {
  clockLabel,
  options as questionOptions,
  questionTitle,
  rankTap,
  recommendedValue,
  sliderSpec,
  toggleOption,
  type AnswerValue,
  type IntakeAnswers,
  type QuestionDef,
} from '@apm/planning';
import { Body, Fill, Muted, QuestionTitle, Row, TextField } from '../ui';
import { Chip, OptionButton, Stepper, intakeStyles } from './primitives';

const WEEKDAY_LABELS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/**
 * One question per screen (docs/34 §4.1). Single-selects move on by themselves 250 ms after
 * the tap, except with a screen reader on: then Continue is used and focus lands on the
 * heading. Sliders are steppers (−/+) that save on each step; the text box saves 300 ms
 * after typing stops.
 */
export function QuestionView({ question, answers, onSet, onAutoAdvance, screenReader, preselectNote, intro }: {
  question: QuestionDef;
  answers: IntakeAnswers;
  /** Writes one answer to the draft store (this question's, or e.g. the weight unit). */
  onSet: (id: string, value: AnswerValue | undefined) => void;
  onAutoAdvance: () => void;
  screenReader: boolean;
  preselectNote?: string;
  intro?: string;
}) {
  const heading = useRef<React.ComponentRef<typeof View>>(null);
  const title = questionTitle(question, answers);
  const value = answers[question.id];
  const recommended = recommendedValue(question, answers);
  const prefilled = answers[`_pf_${question.id}`] === true;
  const onAnswer = (next: AnswerValue | undefined) => onSet(question.id, next);
  const isScale = question.type === 'slider' || question.type === 'time';
  // A scale's default counts as an answer the moment the screen shows (as in the prototype).
  useEffect(() => {
    if (isScale && typeof value !== 'number') onAnswer(sliderSpec(question, answers).def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  useEffect(() => {
    if (!screenReader || !heading.current || Platform.OS === 'web') return;
    try {
      const node = findNodeHandle(heading.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    } catch { /* focus is a nicety; never break the question */ }
  }, [question.id, screenReader]);

  const pickSingle = (v: string) => {
    onAnswer(v);
    if (!screenReader) setTimeout(onAutoAdvance, 250);
  };

  let body: React.ReactNode = null;
  if (question.type === 'single') {
    body = (
      <View style={intakeStyles.stack} accessibilityRole="radiogroup">
        {questionOptions(question, answers).map(([v, label]) => (
          <OptionButton key={v} label={label} selected={value === v} recommended={recommended === v} onPress={() => pickSingle(v)} />
        ))}
      </View>
    );
  } else if (question.type === 'yesno') {
    body = (
      <View style={intakeStyles.stack} accessibilityRole="radiogroup">
        {([[true, 'Yes'], [false, 'No']] as const).map(([v, label]) => (
          <OptionButton key={label} label={label} selected={value === v} onPress={() => { onAnswer(v); if (!screenReader) setTimeout(onAutoAdvance, 250); }} />
        ))}
      </View>
    );
  } else if (question.type === 'multi' || question.type === 'weekdays') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    body = (
      <View style={intakeStyles.stack}>
        <View style={intakeStyles.chips}>
          {questionOptions(question, answers).map(([v, label]) => (
            <Chip key={v} label={label} selected={selected.includes(v)} onPress={() => onAnswer(toggleOption(question, answers, v))} />
          ))}
        </View>
        <Muted>{`${prefilled ? 'Pre-filled from your earlier answers. ' : ''}${question.maxPick ? `Pick up to ${question.maxPick}. ` : 'Tap all that apply. '}${selected.length} selected.`}</Muted>
      </View>
    );
  } else if (question.type === 'rank') {
    const order = Array.isArray(value) ? (value as string[]) : [];
    body = (
      <View style={intakeStyles.stack}>
        {questionOptions(question, answers).map(([v, label]) => {
          const index = order.indexOf(v);
          return <OptionButton key={v} role="button" label={`${index >= 0 ? `${index + 1}. ` : ''}${label}`} selected={index >= 0} onPress={() => onAnswer(rankTap(question, answers, v))} />;
        })}
        <Chip role="button" icon="rotate-ccw" label="Reset order" selected={false} onPress={() => onAnswer(undefined)} />
      </View>
    );
  } else if (question.type === 'slider' || question.type === 'time') {
    const spec = sliderSpec(question, answers);
    const current = typeof value === 'number' ? value : spec.def;
    const clamp = (n: number) => Math.min(spec.max, Math.max(spec.min, n));
    const show = (n: number) => (question.type === 'time' ? clockLabel(n) : `${n}${spec.unit ? ` ${spec.unit}` : ''}`);
    const big = question.type === 'time' ? 60 : Math.max(spec.step * 5, 1);
    body = (
      <View style={intakeStyles.stack}>
        <Stepper value={show(current)} label={title} onMinus={() => onAnswer(clamp(current - spec.step))} onPlus={() => onAnswer(clamp(current + spec.step))} />
        <Row justify="space-between" gap="sm">
          <Chip role="button" label={question.type === 'time' ? '−1 h' : `−${big}`} selected={false} onPress={() => onAnswer(clamp(current - big))} />
          <Fill><Muted align="center">{`${spec.lo ?? show(spec.min)} to ${spec.hi ?? show(spec.max)}`}</Muted></Fill>
          <Chip role="button" label={question.type === 'time' ? '+1 h' : `+${big}`} selected={false} onPress={() => onAnswer(clamp(current + big))} />
        </Row>
        {question.id === 'weight_now' ? (
          <View style={intakeStyles.chips}>
            {(['lb', 'kg'] as const).map((unit) => <Chip key={unit} label={unit} selected={(answers.weight_unit ?? 'lb') === unit} onPress={() => { onSet('weight_unit', unit); onAnswer(unit === 'kg' ? 80 : 180); }} />)}
          </View>
        ) : null}
      </View>
    );
  } else if (question.type === 'text') {
    body = <CatchAll value={typeof value === 'string' ? value : ''} onChange={(text) => onAnswer(text || undefined)} />;
  }

  return (
    <View style={intakeStyles.stack}>
      {intro ? <Muted>{intro}</Muted> : null}
      <View ref={heading} accessible accessibilityRole="header" accessibilityLabel={title}><QuestionTitle>{title}</QuestionTitle></View>
      {question.note ? <Body muted>{question.note}</Body> : null}
      {preselectNote ? <Body strong tone="accent">{preselectNote}</Body> : null}
      {body}
      {question.type === 'weekdays' ? <Muted>{(Array.isArray(value) ? (value as string[]) : []).map((d) => WEEKDAY_LABELS[d] ?? d).join(', ')}</Muted> : null}
    </View>
  );
}

function CatchAll({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <View style={intakeStyles.stack}>
      <TextField
        accessibilityLabel="Anything else on your mind"
        value={text}
        multiline
        maxLength={4000}
        placeholder="Worries, commitments, people, dates, anything a question missed. APM sorts it."
        onChangeText={(next) => { setText(next); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => onChange(next), 300); }}
        onBlur={() => onChange(text)}
      />
      <Muted>Optional. Treated as private data: only an approved private route may read it, and the setup never waits for it.</Muted>
    </View>
  );
}
