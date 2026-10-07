import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AccessibilityRole,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { elevation, radius, spacing, tap, useTheme, useThemedStyles, type Palette, type SpaceKey, type Theme, type TypeKey } from '../theme';

/**
 * The A Player Mode primitives (the design system's components). Screens are built ONLY
 * from these: no screen writes a color, a font or a StyleSheet of its own
 * (test/design-system.test.mjs). Every control has an accessibility label, a ≥ 44 pt tap
 * target and scales with Dynamic Type; motion stops when Reduce Motion is on.
 */

export type IconName = React.ComponentProps<typeof Feather>['name'];
type Tone = keyof Pick<Palette, 'ink' | 'inkMuted' | 'accent' | 'warning' | 'danger' | 'success' | 'onPrimary' | 'onAccent' | 'chipOn' | 'onChipOn' | 'onDanger' | 'brass'>;

// ---------------------------------------------------------------- icons and text

/** C's tab icon: the active one sits in a soft Moss pill. */
export function TabIcon({ icon, focused }: { icon: IconName; focused: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tabIcon, { backgroundColor: focused ? colors.accentSoft : 'transparent' }]}>
      <Icon name={icon} size={20} tone={focused ? 'accent' : 'inkMuted'} />
    </View>
  );
}

/** One icon set app-wide: Feather (stroke icons, matching the Outfit line weight). */
export function Icon({ name, size = 20, tone = 'ink', label }: { name: IconName; size?: number; tone?: Tone; label?: string }) {
  const { colors } = useTheme();
  return <Feather name={name} size={size} color={colors[tone]} accessibilityElementsHidden={!label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'} accessibilityLabel={label} />;
}

function Txt({ variant, tone = 'ink', children, align, upper, strike, role, live, numberOfLines, flex, label }: {
  variant: TypeKey; tone?: Tone; children: ReactNode; align?: 'left' | 'center' | 'right'; upper?: boolean; strike?: boolean;
  role?: AccessibilityRole; live?: boolean; numberOfLines?: number; flex?: boolean; label?: string;
}) {
  const { colors, type } = useTheme();
  const { maxFontSizeMultiplier, ...font } = type[variant];
  return (
    <Text
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityLiveRegion={live ? 'polite' : undefined}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      numberOfLines={numberOfLines}
      style={[font, { color: colors[tone] }, align ? { textAlign: align } : null, upper ? styles.upper : null, strike ? styles.strike : null, flex ? styles.flexShrink : null]}
    >
      {children}
    </Text>
  );
}

/** The welcome promise. */
export function Hero({ children }: { children: ReactNode }) { return <Txt variant="hero" role="header">{children}</Txt>; }
/** A screen's title. */
export function Display({ children }: { children: ReactNode }) { return <Txt variant="display" role="header">{children}</Txt>; }
/** One question / one decision per screen: the big question heading. */
export function QuestionTitle({ children }: { children: ReactNode }) { return <Txt variant="question" role="header">{children}</Txt>; }
export function Heading({ children }: { children: ReactNode }) { return <Txt variant="heading" role="header">{children}</Txt>; }
export function CardTitle({ children, tone }: { children: ReactNode; tone?: Tone }) { return <Txt variant="cardTitle" tone={tone} flex>{children}</Txt>; }
export function Body({ children, muted = false, strong = false, tone, align }: { children: ReactNode; muted?: boolean; strong?: boolean; tone?: Tone; align?: 'left' | 'center' }) {
  return <Txt variant={strong ? 'bodyStrong' : 'body'} tone={tone ?? (muted ? 'inkMuted' : 'ink')} align={align}>{children}</Txt>;
}
/** Small secondary text. */
export function Muted({ children, align }: { children: ReactNode; align?: 'left' | 'center' }) { return <Txt variant="small" tone="inkMuted" align={align}>{children}</Txt>; }
export function Small({ children, strong = false, tone = 'ink', strike }: { children: ReactNode; strong?: boolean; tone?: Tone; strike?: boolean }) {
  return <Txt variant={strong ? 'smallStrong' : 'small'} tone={tone} strike={strike}>{children}</Txt>;
}
/** Uppercase label above a value or a card's content. */
export function Label({ children, tone = 'inkMuted' }: { children: ReactNode; tone?: Tone }) { return <Txt variant="label" tone={tone} upper>{children}</Txt>; }
/** Uppercase eyebrow above a screen title (moss). */
export function Eyebrow({ children }: { children: ReactNode }) { return <Txt variant="label" tone="accent" upper>{children}</Txt>; }
/** A section heading inside a screen (C's quiet uppercase rule). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <View style={styles.sectionTitle}><Txt variant="label" tone="inkMuted" upper role="header">{children}</Txt></View>;
}
/** Why the Continue button is disabled, or what went wrong inline: announced to screen readers. */
export function Reason({ children }: { children: ReactNode }) { return <Txt variant="smallStrong" tone="warning" live>{children}</Txt>; }
/** A big number (price, value). */
export function Figure({ children, tone = 'ink' }: { children: ReactNode; tone?: Tone }) { return <Txt variant="display" tone={tone}>{children}</Txt>; }

// ---------------------------------------------------------------- layout

export function Stack({ children, gap = 'sm', align, flex }: { children: ReactNode; gap?: SpaceKey; align?: 'center' | 'stretch' | 'flex-start'; flex?: boolean }) {
  return <View style={[{ gap: spacing[gap] }, align ? { alignItems: align } : null, flex ? styles.flex : null]}>{children}</View>;
}
export function Row({ children, gap = 'xs', wrap = false, justify, align = 'center' }: { children: ReactNode; gap?: SpaceKey; wrap?: boolean; justify?: 'space-between' | 'center' | 'flex-start' | 'flex-end'; align?: 'center' | 'flex-start' | 'baseline' }) {
  return <View style={[styles.row, { gap: spacing[gap], alignItems: align }, wrap ? styles.wrap : null, justify ? { justifyContent: justify } : null]}>{children}</View>;
}
/** A flexible cell inside a Row (takes the remaining width). */
export function Fill({ children, weight = 1 }: { children: ReactNode; weight?: number }) { return <View style={[styles.fill, weight !== 1 ? { flex: weight } : null]}>{children}</View>; }

export const uiStyles = StyleSheet.create({
  stack: { gap: spacing.md },
  stackSm: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
});

// ---------------------------------------------------------------- screen frame

/** The page heading (C): eyebrow, Outfit title, muted subtitle. */
export function Header({ eyebrow, title, subtitle, hero = false }: { eyebrow?: string; title?: string; subtitle?: string; hero?: boolean }) {
  if (!eyebrow && !title && !subtitle) return null;
  return (
    <View style={styles.header}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      {title ? (hero ? <Hero>{title}</Hero> : <Display>{title}</Display>) : null}
      {subtitle ? <Txt variant="body" tone="inkMuted">{subtitle}</Txt> : null}
    </View>
  );
}

/**
 * Every screen's frame: safe areas, the Stone background, a scrolling body with C's 20 pt
 * gutters, an optional fixed top (intake progress) and a fixed footer (sticky CTA, Back /
 * Continue) above a brass hairline.
 */
export function Screen({ children, title, eyebrow, subtitle, top, footer, hero = false, fullBleed = false }: {
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  top?: ReactNode;
  footer?: ReactNode;
  hero?: boolean;
  /** No native header above this screen: the top safe area is ours to pad. */
  fullBleed?: boolean;
}) {
  const s = useThemedStyles(frameStyles);
  return (
    <SafeAreaView style={s.safe} edges={footer || fullBleed ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']}>
      {/* Text boxes (coach, close-the-day note, goals) stay above the keyboard; a tap on a
          button while the keyboard is up still lands (docs/35 E10). */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        {top ? <View style={s.top}>{top}</View> : null}
        <ScrollView contentContainerStyle={s.screen} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <Header eyebrow={eyebrow} title={title} subtitle={subtitle} hero={hero} />
          {children}
        </ScrollView>
        {footer ? <View style={s.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const frameStyles = ({ colors }: Theme) => ({
  safe: { flex: 1, backgroundColor: colors.bg },
  top: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.xs, gap: spacing.xs, backgroundColor: colors.bg },
  screen: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: 64, gap: spacing.lg, backgroundColor: colors.bg },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.xs, backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.brass },
});

// ---------------------------------------------------------------- cards

type CardTone = 'default' | 'accent' | 'warning' | 'danger' | 'muted' | 'feature';
export function Card({ children, tone = 'default' }: { children: ReactNode; tone?: CardTone }) {
  const s = useThemedStyles(cardStyles);
  return <View style={[s.card, s[tone]]}>{children}</View>;
}
const cardStyles = ({ colors }: Theme) => ({
  card: { borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: 'transparent' },
  default: { backgroundColor: colors.surface, borderColor: colors.line },
  feature: { backgroundColor: colors.surface, borderColor: colors.line, borderRadius: radius.xl, padding: spacing.xl, gap: spacing.md, ...elevation.raised, shadowColor: colors.shadow, shadowOpacity: 0.06 },
  accent: { backgroundColor: colors.accentSoft },
  warning: { backgroundColor: colors.warningSoft },
  danger: { backgroundColor: colors.dangerSoft },
  muted: { backgroundColor: colors.surfaceMuted },
});

// ---------------------------------------------------------------- buttons

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'destructive' | 'danger';
/** Pill buttons (C). Primary = Ink with Paper text; accent = Moss; destructive = brick. */
export function Button({ label, onPress, variant = 'primary', disabled = false, icon, large = false, accessibilityLabel, accessibilityHint }: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  icon?: IconName;
  large?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const s = useThemedStyles(buttonStyles);
  const { reducedMotion } = useTheme();
  const v = variant === 'danger' ? 'destructive' : variant;
  const textTone: Tone = v === 'primary' ? 'onPrimary' : v === 'accent' ? 'onAccent' : v === 'destructive' ? 'onDanger' : v === 'ghost' ? 'accent' : 'ink';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.base, large && s.large, s[v], pressed && s.pressed, pressed && !reducedMotion && s.pressedScale, disabled && s.disabled]}
    >
      {icon ? <Icon name={icon} size={18} tone={textTone} /> : null}
      <ButtonText tone={textTone}>{label}</ButtonText>
    </Pressable>
  );
}
function ButtonText({ children, tone }: { children: string; tone: Tone }) {
  const { colors, type } = useTheme();
  const { maxFontSizeMultiplier, ...font } = type.button;
  return <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[font, styles.center, styles.flexShrink, { color: colors[tone] }]}>{children}</Text>;
}
const buttonStyles = ({ colors }: Theme) => ({
  base: { minHeight: tap.button, borderRadius: radius.pill, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: spacing.xs, borderWidth: 1, borderColor: 'transparent' },
  large: { minHeight: tap.primary },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  accent: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.surface, borderColor: colors.lineStrong },
  ghost: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
  destructive: { backgroundColor: colors.danger, borderColor: colors.danger },
  pressed: { opacity: 0.86 },
  pressedScale: { transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.42 },
});

/** A text link (≥ 44 pt tall). */
export function LinkButton({ label, children, onPress, role = 'button', disabled = false, align = 'flex-start', muted = false, accessibilityLabel }: {
  /** The words (or pass them as children). */
  label?: string; children?: string; onPress: () => void; role?: 'button' | 'link'; disabled?: boolean; align?: 'flex-start' | 'center'; muted?: boolean; accessibilityLabel?: string;
}) {
  const words = label ?? children ?? '';
  return (
    <Pressable accessibilityRole={role} accessibilityLabel={accessibilityLabel ?? words} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.link, { alignSelf: align }, pressed && styles.pressed, disabled && styles.dim]}>
      <Txt variant="smallStrong" tone={muted ? 'inkMuted' : 'accent'} align={align === 'center' ? 'center' : 'left'}>{words}</Txt>
    </Pressable>
  );
}

// ---------------------------------------------------------------- chips and answer cards

/** A pill chip. Selected = Ink with Paper text plus a check (never color alone). */
export function Chip({ label, selected, onPress, role = 'checkbox', icon }: { label: string; selected: boolean; onPress: () => void; role?: 'checkbox' | 'radio' | 'button'; icon?: IconName }) {
  const s = useThemedStyles(chipStyles);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === 'checkbox' ? { checked: selected } : { selected }}
      onPress={onPress}
      style={({ pressed }) => [s.chip, selected && s.on, pressed && styles.pressed]}
    >
      {selected ? <Icon name="check" size={16} tone="onChipOn" /> : icon ? <Icon name={icon} size={16} tone="inkMuted" /> : null}
      <Txt variant="chip" tone={selected ? 'onChipOn' : 'ink'} flex>{label}</Txt>
    </Pressable>
  );
}
const chipStyles = ({ colors }: Theme) => ({
  chip: { minHeight: tap.min, minWidth: tap.min, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6 },
  on: { backgroundColor: colors.chipOn, borderColor: colors.chipOn },
});

/** A row of single-choice chips (one question at a time, no free-form form walls). */
export function ChoiceRow<T extends string | number>({ options, value, onChange }: {
  options: Array<{ id: T; label: string }>;
  value?: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={[styles.row, styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup">
      {options.map((option) => <Chip key={String(option.id)} role="radio" label={option.label} selected={option.id === value} onPress={() => onChange(option.id)} />)}
    </View>
  );
}

/** C's big tappable answer card: one answer per card, ≥ 64 pt, a check ring that fills when chosen. */
export function AnswerCard({ label, detail, selected, onPress, recommended, role = 'radio', icon }: {
  label: string; detail?: string; selected: boolean; onPress: () => void; recommended?: boolean; role?: 'radio' | 'checkbox' | 'button'; icon?: IconName;
}) {
  const s = useThemedStyles(answerStyles);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === 'checkbox' ? { checked: selected } : { selected }}
      accessibilityLabel={`${label}${recommended ? ', recommended' : ''}`}
      accessibilityHint={detail}
      onPress={onPress}
      style={({ pressed }) => [s.card, selected && s.on, pressed && styles.pressed]}
    >
      {role !== 'button' ? (
        <View style={[s.ring, selected && s.ringOn]}>{selected ? <Icon name="check" size={14} tone="chipOn" /> : null}</View>
      ) : icon ? <Icon name={icon} size={20} tone="accent" /> : null}
      <View style={styles.fill}>
        {recommended ? <View style={[s.badge, selected && s.badgeOn]}><Txt variant="label" tone={selected ? 'onChipOn' : 'accent'} upper>Recommended</Txt></View> : null}
        <Txt variant="button" tone={selected ? 'onChipOn' : 'ink'}>{label}</Txt>
        {detail ? <Txt variant="small" tone={selected ? 'onChipOn' : 'inkMuted'}>{detail}</Txt> : null}
      </View>
      {role === 'button' && !recommended ? <Icon name="chevron-right" size={18} tone={selected ? 'onChipOn' : 'inkMuted'} /> : null}
    </Pressable>
  );
}
const answerStyles = ({ colors }: Theme) => ({
  card: { minHeight: tap.answer, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
  on: { backgroundColor: colors.chipOn, borderColor: colors.chipOn },
  ring: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: 'center' as const, justifyContent: 'center' as const },
  ringOn: { backgroundColor: colors.onChipOn, borderColor: colors.onChipOn },
  badge: { alignSelf: 'flex-start' as const, borderRadius: radius.pill, backgroundColor: colors.accentSoft, paddingHorizontal: spacing.xs, paddingVertical: 3, marginBottom: 4 },
  badgeOn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.onChipOn },
});

/** −/+ stepper for numbers and times (each step saves). */
export function Stepper({ value, label, onMinus, onPlus, minusLabel = 'Less', plusLabel = 'More' }: {
  value: string; label: string; onMinus: () => void; onPlus: () => void; minusLabel?: string; plusLabel?: string;
}) {
  const s = useThemedStyles(stepperStyles);
  return (
    <View style={s.stepper} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => (event.nativeEvent.actionName === 'increment' ? onPlus() : onMinus())}>
      <Pressable accessibilityRole="button" accessibilityLabel={minusLabel} onPress={onMinus} style={({ pressed }) => [s.step, pressed && styles.pressed]}><Icon name="minus" size={24} /></Pressable>
      <View style={styles.fill}><Txt variant="display" align="center">{value}</Txt></View>
      <Pressable accessibilityRole="button" accessibilityLabel={plusLabel} onPress={onPlus} style={({ pressed }) => [s.step, pressed && styles.pressed]}><Icon name="plus" size={24} /></Pressable>
    </View>
  );
}
const stepperStyles = ({ colors }: Theme) => ({
  stepper: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, padding: spacing.sm },
  step: { width: tap.primary, height: tap.primary, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, alignItems: 'center' as const, justifyContent: 'center' as const },
});

// ---------------------------------------------------------------- progress

/** C's progress bar: an 8 pt pill in Moss on the line color; animates unless Reduce Motion is on. */
export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }) {
  const s = useThemedStyles(progressStyles);
  const { reducedMotion } = useTheme();
  const pct = total ? Math.min(100, Math.round((100 * done) / total)) : 0;
  const width = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    if (reducedMotion) { width.setValue(pct); return; }
    Animated.timing(width, { toValue: pct, duration: 280, useNativeDriver: false }).start();
  }, [pct, reducedMotion, width]);
  return (
    <View style={s.track} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Progress'} accessibilityValue={{ min: 0, max: total, now: done }}>
      <Animated.View style={[s.fill, { width: width.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]} />
    </View>
  );
}
const progressStyles = ({ colors }: Theme) => ({
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.line, overflow: 'hidden' as const },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.accent },
});

// ---------------------------------------------------------------- small pieces

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'solid' }) {
  const s = useThemedStyles(pillStyles);
  const text: Tone = tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : tone === 'danger' ? 'danger' : tone === 'accent' ? 'accent' : tone === 'solid' ? 'onAccent' : 'ink';
  return <View style={[s.pill, s[tone]]}><Txt variant="smallStrong" tone={text}>{children}</Txt></View>;
}
const pillStyles = ({ colors }: Theme) => ({
  pill: { alignSelf: 'flex-start' as const, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  neutral: { backgroundColor: colors.surfaceMuted },
  accent: { backgroundColor: colors.accentSoft },
  solid: { backgroundColor: colors.accent },
  success: { backgroundColor: colors.successSoft },
  warning: { backgroundColor: colors.warningSoft },
  danger: { backgroundColor: colors.dangerSoft },
});

/** A small padded block inside a card (tier-grid cells); highlighted = the recommended column. */
export function Tile({ children, highlight = false }: { children: ReactNode; highlight?: boolean }) {
  const { colors } = useTheme();
  return <View style={[styles.tile, { backgroundColor: highlight ? colors.accentSoft : 'transparent' }]}>{children}</View>;
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Txt variant="label" tone="inkMuted" upper>{label}</Txt>
      <Txt variant="bodyStrong">{value}</Txt>
    </View>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.line }]} />;
}

/** A bullet line with C's round dot, in brass. */
export function ListItem({ title, detail }: { title: string; detail?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, styles.top]}>
      <View style={[styles.dot, { backgroundColor: colors.brass }]} />
      <View style={styles.fill}>
        <Txt variant="bodyStrong">{title}</Txt>
        {detail ? <Txt variant="small" tone="inkMuted">{detail}</Txt> : null}
      </View>
    </View>
  );
}

/** Numbered steps joined by a hairline. */
export function Flow({ steps }: { steps: string[] }) {
  const s = useThemedStyles(flowStyles);
  return (
    <View style={s.wrap}>
      {steps.map((step, index) => (
        <View key={step} style={s.item}>
          <View style={s.num}><Txt variant="smallStrong" tone="onPrimary">{String(index + 1)}</Txt></View>
          <View style={styles.fill}><Txt variant="body">{step}</Txt></View>
        </View>
      ))}
    </View>
  );
}
const flowStyles = ({ colors }: Theme) => ({
  wrap: { gap: spacing.sm },
  item: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: spacing.sm },
  num: { width: 28, height: 28, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: 'center' as const, justifyContent: 'center' as const },
});

/** A navigation row (Settings, coach tools): icon, title, detail, chevron. */
export function ListRow({ title, detail, onPress, icon, accessibilityLabel }: { title: string; detail?: string; onPress: () => void; icon?: IconName; accessibilityLabel?: string }) {
  const s = useThemedStyles(listRowStyles);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={detail} onPress={onPress} style={({ pressed }) => [s.row, pressed && styles.pressed]}>
      {icon ? <View style={s.icon}><Icon name={icon} size={18} tone="accent" /></View> : null}
      <View style={styles.fill}>
        <Txt variant="cardTitle">{title}</Txt>
        {detail ? <Txt variant="small" tone="inkMuted">{detail}</Txt> : null}
      </View>
      <Icon name="chevron-right" size={20} tone="inkMuted" />
    </Pressable>
  );
}
const listRowStyles = ({ colors }: Theme) => ({
  row: { minHeight: tap.answer, flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  icon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.accentSoft, alignItems: 'center' as const, justifyContent: 'center' as const },
});

/** Progressive disclosure: a titled card that opens on tap (Today's detail, the coach's other modes). */
export function Disclosure({ title, summary, children, initiallyOpen = false, icon }: { title: string; summary?: string; children: ReactNode; initiallyOpen?: boolean; icon?: IconName }) {
  const [open, setOpen] = useState(initiallyOpen);
  const s = useThemedStyles(disclosureStyles);
  return (
    <View style={s.wrap}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={summary} accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={({ pressed }) => [s.head, pressed && styles.pressed]}>
        {icon ? <Icon name={icon} size={18} tone="accent" /> : null}
        <View style={styles.fill}>
          <Txt variant="cardTitle">{title}</Txt>
          {summary && !open ? <Txt variant="small" tone="inkMuted">{summary}</Txt> : null}
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} tone="inkMuted" />
      </Pressable>
      {open ? <View style={s.body}>{children}</View> : null}
    </View>
  );
}
const disclosureStyles = ({ colors }: Theme) => ({
  wrap: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' as const },
  head: { minHeight: tap.answer, flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
});

/** The "taken off your plate" line (C plate, brass dot): same place on every screen, just above the buttons. */
export function PlateLine({ text }: { text: string }) {
  const s = useThemedStyles(plateStyles);
  if (!text) return null;
  const body = text.replace(/^Taken off your plate: /, '');
  return (
    <View style={s.plate} accessibilityRole="text">
      <View style={s.dot} />
      <View style={styles.fill}>
        <Txt variant="label" tone="inkMuted" upper>Taken off your plate</Txt>
        <Txt variant="small">{body ? body[0]!.toUpperCase() + body.slice(1) : body}</Txt>
      </View>
    </View>
  );
}
const plateStyles = ({ colors }: Theme) => ({
  plate: { flexDirection: 'row' as const, gap: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: spacing.md },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brass, marginTop: 3 },
});

// ---------------------------------------------------------------- fields

/** A labelled text field: Paper, a ≥ 3:1 border, Moss focus ring. */
export function TextField({ value, onChangeText, placeholder, multiline = false, label, code = false, accessibilityLabel, ...native }: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  label?: string;
  /** The 6-digit code look: big, spaced, centred. */
  code?: boolean;
  accessibilityLabel?: string;
} & Pick<TextInputProps, 'autoCapitalize' | 'autoComplete' | 'keyboardType' | 'textContentType' | 'maxLength' | 'onSubmitEditing' | 'onBlur' | 'returnKeyType'>) {
  const s = useThemedStyles(fieldStyles);
  const { colors, type } = useTheme();
  const [focused, setFocused] = useState(false);
  const { maxFontSizeMultiplier, ...font } = type.body;
  return (
    <View style={styles.field}>
      {label ? <Txt variant="smallStrong" tone="ink">{label}</Txt> : null}
      <TextInput
        {...native}
        accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkMuted}
        multiline={multiline}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        onFocus={() => setFocused(true)}
        onBlur={(event) => { setFocused(false); native.onBlur?.(event); }}
        style={[font, s.input, multiline && s.multiline, code && s.code, focused && s.focused] as TextInputProps['style']}
      />
    </View>
  );
}
const fieldStyles = ({ colors }: Theme) => ({
  input: { minHeight: tap.button, backgroundColor: colors.surface, borderColor: colors.lineStrong, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.ink, fontSize: 17 },
  multiline: { minHeight: 120, textAlignVertical: 'top' as const },
  code: { fontSize: 26, letterSpacing: 8, textAlign: 'center' as const },
  focused: { borderColor: colors.accent, borderWidth: 2 },
  timeRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
});

/** "HH:MM" ⇄ Date (today, local) for the time pickers (src/components/TimePickerField*.tsx). */
export function hhmmToDate(value: string): Date {
  const [h, m] = /^\d{2}:\d{2}$/.test(value) ? value.split(':').map(Number) as [number, number] : [7, 0];
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}
export function dateToHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** "06:30" → "6:30 AM" in the phone's own clock style. */
export function clockText(value: string): string {
  return /^\d{2}:\d{2}$/.test(value) ? hhmmToDate(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

/** The field a time picker sits in: label, the time in plain words, a clock icon, optional Clear. */
export function TimeField({ label, value, placeholder, open, onPress, onClear, children }: {
  label: string; value: string; placeholder: string; open: boolean; onPress?: () => void; onClear?: () => void; children?: ReactNode;
}) {
  const s = useThemedStyles(fieldStyles);
  const shown = clockText(value);
  return (
    <View style={styles.field}>
      <Txt variant="smallStrong">{label}</Txt>
      {onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${shown || placeholder}`} accessibilityHint="Opens the time picker" accessibilityState={{ expanded: open }} onPress={onPress}
          style={({ pressed }) => [s.input, s.timeRow, open && s.focused, pressed && styles.pressed]}>
          <Txt variant="body" tone={shown ? 'ink' : 'inkMuted'} flex>{shown || placeholder}</Txt>
          <Icon name="clock" size={18} tone="inkMuted" />
        </Pressable>
      ) : children}
      {onClear ? <LinkButton label="Clear" accessibilityLabel={`Clear ${label}`} onPress={onClear} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- states and feedback

/** Nothing here yet: an icon, one plain sentence, and the one thing to do about it. */
export function EmptyState({ icon = 'inbox', title, body, actionLabel, onAction }: { icon?: IconName; title: string; body?: string; actionLabel?: string; onAction?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.state, { backgroundColor: colors.surfaceMuted }]}>
      <View style={[styles.stateIcon, { backgroundColor: colors.surface }]}><Icon name={icon} size={22} tone="accent" /></View>
      <Txt variant="cardTitle" align="center">{title}</Txt>
      {body ? <Txt variant="small" tone="inkMuted" align="center">{body}</Txt> : null}
      {actionLabel && onAction ? <Button label={actionLabel} variant="secondary" onPress={onAction} /> : null}
    </View>
  );
}

/** Something failed: a plain sentence (never a code) and, when it can be retried, Try again. */
export function ErrorState({ title, message, onRetry, retryLabel = 'Try again' }: { title?: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <Card tone="danger">
      <Row gap="xs" align="flex-start">
        <Icon name="alert-circle" size={20} tone="danger" />
        <Fill>
          <Stack gap="xxs">
            {title ? <CardTitle>{title}</CardTitle> : null}
            <Txt variant="body" live>{message}</Txt>
          </Stack>
        </Fill>
      </Row>
      {onRetry ? <Button label={retryLabel} variant="secondary" icon="refresh-cw" onPress={onRetry} /> : null}
    </Card>
  );
}

/** A status message after an action ("Saved.", "Reported."): announced, fades in unless Reduce Motion. */
export function Toast({ message, tone = 'neutral' }: { message?: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const s = useThemedStyles(toastStyles);
  const { reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (!message) return;
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(message);
    if (reducedMotion) { opacity.setValue(1); return; }
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [message, opacity, reducedMotion]);
  if (!message) return null;
  const icon: IconName = tone === 'success' ? 'check-circle' : tone === 'warning' ? 'alert-triangle' : tone === 'danger' ? 'alert-circle' : 'info';
  const text: Tone = tone === 'neutral' ? 'onPrimary' : 'ink';
  return (
    <Animated.View style={[s.toast, s[tone], { opacity }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Icon name={icon} size={18} tone={tone === 'neutral' ? 'onPrimary' : tone === 'success' ? 'success' : tone} />
      <View style={styles.fill}><Txt variant="body" tone={text}>{message}</Txt></View>
    </Animated.View>
  );
}
const toastStyles = ({ colors }: Theme) => ({
  toast: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: spacing.sm, borderRadius: radius.lg, padding: spacing.md },
  neutral: { backgroundColor: colors.primary, ...elevation.raised, shadowColor: colors.shadow },
  success: { backgroundColor: colors.successSoft },
  warning: { backgroundColor: colors.warningSoft },
  danger: { backgroundColor: colors.dangerSoft },
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabIcon: { width: 48, height: 26, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0, gap: 2 },
  flexShrink: { flexShrink: 1 },
  row: { flexDirection: 'row' },
  wrap: { flexWrap: 'wrap' },
  top: { alignItems: 'flex-start', gap: spacing.sm },
  center: { textAlign: 'center' },
  upper: { textTransform: 'uppercase' },
  strike: { textDecorationLine: 'line-through' },
  header: { gap: spacing.xs },
  sectionTitle: { marginTop: spacing.xs, marginBottom: -spacing.xs },
  pressed: { opacity: 0.86 },
  dim: { opacity: 0.5 },
  link: { minHeight: tap.min, justifyContent: 'center', paddingVertical: spacing.xxs },
  keyValue: { gap: 2 },
  tile: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.xxs },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  field: { gap: spacing.xs },
  state: { borderRadius: radius.xl, padding: spacing.xl, gap: spacing.sm, alignItems: 'center' },
  stateIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
