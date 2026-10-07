import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../../theme';

/**
 * Intake building blocks (docs/34 §4.1, §6.1): options ≥ 48 pt, chips ≥ 44 pt, selection
 * shown by a check mark as well as colour, screen-reader state on every control.
 */

export function OptionButton({ label, detail, selected, onPress, recommended, role = 'radio' }: {
  label: string; detail?: string; selected: boolean; onPress: () => void; recommended?: boolean; role?: 'radio' | 'checkbox' | 'button';
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === 'checkbox' ? { checked: selected } : { selected }}
      accessibilityLabel={`${label}${recommended ? ', recommended' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}
    >
      <View style={styles.optionRow}>
        <Text style={[styles.check, selected && styles.checkOn]}>{selected ? '✓' : ''}</Text>
        <View style={styles.optionTextWrap}>
          <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
          {detail ? <Text style={[styles.optionDetail, selected && styles.optionTextSelected]}>{detail}</Text> : null}
        </View>
        {recommended ? <Text style={[styles.badge, selected && styles.badgeOn]}>Recommended</Text> : null}
      </View>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{selected ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

export function Stepper({ value, label, onMinus, onPlus, minusLabel = 'Less', plusLabel = 'More' }: {
  value: string; label: string; onMinus: () => void; onPlus: () => void; minusLabel?: string; plusLabel?: string;
}) {
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => (event.nativeEvent.actionName === 'increment' ? onPlus() : onMinus())}>
      <Pressable accessibilityRole="button" accessibilityLabel={minusLabel} onPress={onMinus} style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}><Text style={styles.stepText}>−</Text></Pressable>
      <Text style={styles.stepValue}>{value}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={plusLabel} onPress={onPlus} style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}><Text style={styles.stepText}>+</Text></Pressable>
    </View>
  );
}

const capitalise = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/** The "taken off your plate" line: same place on every screen, just above the buttons. */
export function PlateLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <View style={styles.plate} accessibilityRole="text">
      <Text style={styles.plateLabel}>Taken off your plate</Text>
      <Text style={styles.plateText}>{capitalise(text.replace(/^Taken off your plate: /, ''))}</Text>
    </View>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((100 * done) / total)) : 0;
  return (
    <View style={styles.barTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total, now: done }}>
      <View style={[styles.barFill, { width: `${pct}%` }]} />
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export const intakeStyles = StyleSheet.create({
  heading: { color: colors.ink, fontSize: 26, lineHeight: 32, fontWeight: '800' },
  note: { color: colors.inkMuted, fontSize: 15, lineHeight: 21 },
  why: { color: colors.warning, fontSize: 14, fontWeight: '700' },
  stack: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});

const styles = StyleSheet.create({
  option: { minHeight: 48, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'center' },
  optionSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionTextWrap: { flex: 1, gap: 2 },
  optionText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  optionDetail: { color: colors.inkMuted, fontSize: 13, lineHeight: 18 },
  optionTextSelected: { color: '#FFFFFF' },
  check: { width: 18, color: colors.inkMuted, fontSize: 16, fontWeight: '900' },
  checkOn: { color: '#FFFFFF' },
  badge: { fontSize: 11, fontWeight: '800', color: colors.accent, backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  badgeOn: { color: colors.accent, backgroundColor: '#FFFFFF' },
  chip: { minHeight: 44, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: 14, justifyContent: 'center' },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  chipTextSelected: { color: '#FFFFFF' },
  pressed: { opacity: 0.75 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  stepButton: { width: 56, height: 56, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 26, fontWeight: '800', color: colors.ink },
  stepValue: { flex: 1, textAlign: 'center', fontSize: 30, fontWeight: '800', color: colors.ink },
  plate: { borderLeftWidth: 3, borderLeftColor: colors.accent, backgroundColor: colors.accentSoft, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  plateLabel: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  plateText: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
  muted: { color: colors.inkMuted, fontSize: 14, lineHeight: 20 },
});
