import { useEffect, useRef, useState } from 'react';
import { Platform, View, findNodeHandle, AccessibilityInfo } from 'react-native';
import {
  OTHER_LABEL,
  OTHER_OPTION,
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
import { DatePicker } from '../DatePickerField';
import { localDateToIso } from '../dateField';
import { scaleStep, typedNumber } from './scale';
import { Chip, OptionButton, Stepper, intakeStyles } from './primitives';

const WEEKDAY_LABELS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/**
 * One question per screen (docs/34 §4.1). Single-selects move on by themselves 250 ms after
 * the tap, except with a screen reader on: then Continue is used and focus lands on the
 * heading. Sliders are steppers (−/+) that save on each step, and only then: an untouched
 * slider saves nothing and Continue reads "Skip" (owner review 14 Nov 2026). The weight is
 * typed, starting blank. The text box saves 300 ms after typing stops.
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
  const otherId = question.other;
  const otherValue = otherId && typeof answers[otherId] === 'string' ? (answers[otherId] as string) : '';

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
        {otherId ? <OptionButton label={OTHER_LABEL} selected={value === OTHER_OPTION} onPress={() => onAnswer(OTHER_OPTION)} /> : null}
        {otherId && value === OTHER_OPTION ? <OwnWords id={otherId} value={otherValue} onSet={onSet} /> : null}
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
        {otherId && selected.includes(OTHER_OPTION) ? <OwnWords id={otherId} value={otherValue} onSet={onSet} /> : null}
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
  } else if (question.typed) {
    const spec = sliderSpec(question, answers);
    body = (
      <View style={intakeStyles.stack}>
        <TypedNumber key={String(answers.weight_unit ?? 'lb')} label={`${title} (${spec.unit})`} unit={spec.unit} min={spec.min} max={spec.max} value={typeof value === 'number' ? value : undefined} onChange={onAnswer} />
        {question.id === 'weight_now' ? (
          <View style={intakeStyles.chips}>
            {(['lb', 'kg'] as const).map((unit) => <Chip key={unit} label={unit} selected={(answers.weight_unit ?? 'lb') === unit} onPress={() => { onSet('weight_unit', unit); onAnswer(undefined); }} />)}
          </View>
        ) : null}
      </View>
    );
  } else if (question.type === 'slider' || question.type === 'time') {
    const spec = sliderSpec(question, answers);
    const set = typeof value === 'number';
    const shown = set ? (value as number) : spec.def;
    const show = (n: number) => (question.type === 'time' ? clockLabel(n) : `${n}${spec.unit ? ` ${spec.unit}` : ''}`);
    const big = question.type === 'time' ? 60 : Math.max(spec.step * 5, Math.round((spec.max - spec.min) / 20 / spec.step) * spec.step, 1);
    const step = (delta: number) => onAnswer(scaleStep({ type: question.type, min: spec.min, max: spec.max, value: set ? (value as number) : undefined, def: spec.def, delta }));
    body = (
      <View style={intakeStyles.stack}>
        <Stepper value={set ? show(shown) : `Not set (${show(spec.def)}?)`} label={title} onMinus={() => step(-spec.step)} onPlus={() => step(spec.step)} />
        <Row justify="space-between" gap="sm">
          <Chip role="button" label={question.type === 'time' ? '−1 h' : `−${big}`} selected={false} onPress={() => step(-big)} />
          <Fill><Muted align="center">{question.type === 'time' ? 'Any time of day' : `${spec.lo ?? show(spec.min)} to ${spec.hi ?? show(spec.max)}`}</Muted></Fill>
          <Chip role="button" label={question.type === 'time' ? '+1 h' : `+${big}`} selected={false} onPress={() => step(big)} />
        </Row>
        {!set ? <Chip role="button" label={`Use ${show(spec.def)}`} selected={false} onPress={() => onAnswer(spec.def)} /> : null}
      </View>
    );
  } else if (question.type === 'date') {
    body = <DatePicker label={title} value={typeof value === 'string' ? value : ''} minDate={localDateToIso(new Date())} onChange={(next) => onAnswer(next || undefined)} />;
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

/** Her own words for "Something else": saved 300 ms after typing stops. */
function OwnWords({ id, value, onSet }: { id: string; value: string; onSet: (id: string, value: AnswerValue | undefined) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <TextField
      label="In a few words"
      accessibilityLabel="Something else, in your own words"
      value={text}
      maxLength={120}
      placeholder="Type it here"
      onChangeText={(next) => { setText(next); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => onSet(id, next.trim() ? next : undefined), 300); }}
      onBlur={() => onSet(id, text.trim() ? text : undefined)}
    />
  );
}

/** A number she types (her weight): blank until she types, saved only when it is in range. */
function TypedNumber({ label, unit, min, max, value, onChange }: { label: string; unit: string; min: number; max: number; value?: number; onChange: (value: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const parsed = typedNumber(text, min, max);
  return (
    <View style={intakeStyles.stack}>
      <TextField label={label} accessibilityLabel={label} value={text} keyboardType="number-pad" maxLength={3} placeholder={`e.g. in ${unit}`}
        onChangeText={(next) => { setText(next); onChange(typedNumber(next, min, max)); }} />
      {text.trim() && parsed === undefined ? <Muted>{`Type a number between ${min} and ${max}, or tap Skip.`}</Muted> : null}
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
