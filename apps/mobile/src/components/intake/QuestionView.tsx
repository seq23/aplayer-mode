import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View, findNodeHandle, AccessibilityInfo, StyleSheet } from 'react-native';
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
import { colors, radius, spacing } from '../../theme';
import { Chip, Muted, OptionButton, Stepper, intakeStyles } from './primitives';

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
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
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
        <Chip label="Reset order" selected={false} onPress={() => onAnswer(undefined)} />
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
        <View style={styles.ends}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Down by ${question.type === 'time' ? 'an hour' : big}`} onPress={() => onAnswer(clamp(current - big))} style={styles.jump}><Text style={styles.jumpText}>{question.type === 'time' ? '−1 h' : `−${big}`}</Text></Pressable>
          <Text style={styles.endLabel}>{spec.lo ?? show(spec.min)} to {spec.hi ?? show(spec.max)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Up by ${question.type === 'time' ? 'an hour' : big}`} onPress={() => onAnswer(clamp(current + big))} style={styles.jump}><Text style={styles.jumpText}>{question.type === 'time' ? '+1 h' : `+${big}`}</Text></Pressable>
        </View>
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
      <Text ref={heading} accessibilityRole="header" style={intakeStyles.heading}>{title}</Text>
      {question.note ? <Text style={intakeStyles.note}>{question.note}</Text> : null}
      {preselectNote ? <Text style={[intakeStyles.note, styles.preselect]}>{preselectNote}</Text> : null}
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
      <TextInput
        accessibilityLabel="Anything else on your mind"
        value={text}
        multiline
        maxLength={4000}
        placeholder="Worries, commitments, people, dates, anything a question missed. APM sorts it."
        placeholderTextColor={colors.inkMuted}
        onChangeText={(next) => { setText(next); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => onChange(next), 300); }}
        onBlur={() => onChange(text)}
        style={styles.textBox}
      />
      <Muted>Optional. Treated as private data: only an approved private route may read it, and the setup never waits for it.</Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  ends: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  endLabel: { flex: 1, textAlign: 'center', color: colors.inkMuted, fontSize: 13 },
  jump: { minHeight: 44, minWidth: 64, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  jumpText: { color: colors.ink, fontWeight: '800' },
  textBox: { minHeight: 140, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: 14, fontSize: 16, color: colors.ink, textAlignVertical: 'top' },
  preselect: { color: colors.accent, fontWeight: '700' },
});
