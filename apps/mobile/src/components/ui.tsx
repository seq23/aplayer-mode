import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme';

export function Screen({
  children,
  title,
  eyebrow,
  subtitle,
}: {
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {/* Text boxes (coach, close-the-day note, goals) stay above the keyboard; a tap on a
          button while the keyboard is up still lands (docs/35 E10). */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        {(eyebrow || title || subtitle) && (
          <View style={styles.headingWrap}>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        )}
        {children}
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  tone = 'default',
}: {
  children: ReactNode;
  style?: ViewProps['style'];
  tone?: 'default' | 'accent' | 'warning' | 'danger' | 'muted';
}) {
  const toneStyle = {
    default: styles.card,
    accent: [styles.card, styles.cardAccent],
    warning: [styles.card, styles.cardWarning],
    danger: [styles.card, styles.cardDanger],
    muted: [styles.card, styles.cardMuted],
  }[tone];

  return <View style={[toneStyle, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.cardTitle}>{children}</Text>;
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.bodyMuted]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === 'secondary' && styles.buttonSecondaryText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return (
    <View
      style={[
        styles.pill,
        tone === 'success' && styles.pillSuccess,
        tone === 'warning' && styles.pillWarning,
        tone === 'danger' && styles.pillDanger,
      ]}
    >
      <Text style={styles.pillText}>{children}</Text>
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.key}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  multiline = false,
  label,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  label?: string;
}) {
  return (
    <View style={styles.fieldWrap}>
      {label ? <Text style={styles.key}>{label}</Text> : null}
      <TextInput
        accessibilityLabel={label ?? placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkMuted}
        multiline={multiline}
        style={[styles.field, multiline && styles.fieldMultiline]}
      />
    </View>
  );
}

/** A row of single-choice chips (one question at a time, no free-form form walls). */
export function ChoiceRow<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string }>;
  value?: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => (
        <Pressable
          key={String(option.id)}
          accessibilityRole="button"
          accessibilityState={{ selected: option.id === value }}
          onPress={() => onChange(option.id)}
          style={({ pressed }) => [styles.choice, option.id === value && styles.choiceSelected, pressed && styles.pressed]}
        >
          <Text style={[styles.choiceText, option.id === value && styles.choiceTextSelected]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Flow({ steps }: { steps: string[] }) {
  return (
    <View style={styles.flowWrap}>
      {steps.map((step, index) => (
        <View key={step} style={styles.flowItem}>
          <View style={styles.flowNumber}>
            <Text style={styles.flowNumberText}>{index + 1}</Text>
          </View>
          <Text style={styles.flowText}>{step}</Text>
          {index < steps.length - 1 ? <Text style={styles.flowArrow}>↓</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function ListItem({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.listItem}>
      <View style={styles.bullet} />
      <View style={styles.listText}>
        <Text style={styles.listTitle}>{title}</Text>
        {detail ? <Text style={styles.listDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

export const uiStyles = StyleSheet.create({
  stack: { gap: spacing.md },
  stackSm: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  screen: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: 64,
    gap: spacing.lg,
    backgroundColor: colors.background,
  },
  headingWrap: { gap: spacing.sm },
  eyebrow: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 39,
    fontWeight: '800',
    letterSpacing: -1,
  },
  subtitle: {
    color: colors.inkMuted,
    fontSize: 17,
    lineHeight: 25,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardAccent: { backgroundColor: colors.accentSoft, borderColor: '#B7D1C6' },
  cardWarning: { backgroundColor: colors.warningSoft, borderColor: '#DFC49D' },
  cardDanger: { backgroundColor: colors.dangerSoft, borderColor: '#E5B9BD' },
  cardMuted: { backgroundColor: colors.surfaceMuted },
  sectionTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
  },
  cardTitle: { color: colors.ink, fontSize: 19, lineHeight: 24, fontWeight: '700' },
  body: { color: colors.ink, fontSize: 16, lineHeight: 24 },
  bodyMuted: { color: colors.inkMuted },
  label: {
    color: colors.inkMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  button: {
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingVertical: 15,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.danger },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  buttonSecondaryText: { color: colors.ink },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  fieldWrap: { gap: spacing.xs },
  field: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, color: colors.ink, fontSize: 16 },
  fieldMultiline: { minHeight: 88, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choice: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, minWidth: 44, alignItems: 'center' },
  choiceSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  choiceText: { color: colors.ink, fontWeight: '700' },
  choiceTextSelected: { color: '#FFFFFF' },
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillSuccess: { backgroundColor: colors.successSoft },
  pillWarning: { backgroundColor: colors.warningSoft },
  pillDanger: { backgroundColor: colors.dangerSoft },
  pillText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  keyValue: { gap: 3 },
  key: { color: colors.inkMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  value: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.xs },
  flowWrap: { gap: spacing.xs },
  flowItem: { alignItems: 'center', gap: spacing.xs },
  flowNumber: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flowNumberText: { color: '#FFFFFF', fontWeight: '800' },
  flowText: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '700', textAlign: 'center' },
  flowArrow: { color: colors.inkMuted, fontSize: 18 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bullet: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent, marginTop: 8 },
  listText: { flex: 1, gap: 2 },
  listTitle: { color: colors.ink, fontSize: 15, lineHeight: 22, fontWeight: '700' },
  listDetail: { color: colors.inkMuted, fontSize: 14, lineHeight: 20 },
});
