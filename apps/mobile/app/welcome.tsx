import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  CONTINUITY,
  CTA_LABEL,
  FIVE_ROLES,
  HAVE_ACCOUNT_LABEL,
  HERO,
  INSIDE,
  MODES,
  PERSONAS,
  PRIVACY_LINE,
  PRIVACY_LINK_LABEL,
  SITUATIONS,
  TRACKS,
  WELCOME_PLATE,
  WELCOME_TIERS_TEASER,
  WITHOUT_WITH,
} from '../src/content/sell';
import { useSession } from '../src/state/session';
import { useIntake } from '../src/intake/store';
import { PlateLine } from '../src/components/intake/primitives';
import { colors, radius, spacing } from '../src/theme';

/**
 * The welcome page sells (docs/34 §3): the promise first, then the pitch in a scannable
 * order with section headers and expandable cards, a sticky "Start" button, and the CTA
 * again at the end. All copy lives in src/content/sell.ts.
 */
export default function WelcomeScreen() {
  const { startAnonymous } = useSession();
  const { track } = useIntake();
  const { deleted } = useLocalSearchParams<{ deleted?: string }>();
  const start = () => {
    // Silent anonymous session (when the project allows it); the draft is saved on this phone either way.
    void startAnonymous().catch(() => false);
    track('onboarding_started', {});
    router.push('/intake');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {deleted === '1' ? <Text accessibilityLiveRegion="polite" style={styles.strong}>Your account deletion is under way. Everything is erased within 24 hours, and you are signed out.</Text> : null}
        <Text style={styles.eyebrow}>{HERO.eyebrow}</Text>
        <Text accessibilityRole="header" style={styles.headline}>{HERO.headline}</Text>
        <Text style={styles.sub}>{HERO.sub}</Text>
        <View style={styles.empty}><Text style={styles.emptyText}>{HERO.emptyLine}</Text></View>
        <Section title={HERO.definitionTitle}>
          {HERO.definition.map((line) => <Text key={line} style={styles.bullet}>{`• ${line}`}</Text>)}
          <Text style={styles.muted}>{HERO.notThis}</Text>
        </Section>

        <Section title={CONTINUITY.title}>
          <Text style={styles.body}>{CONTINUITY.body}</Text>
          <View style={styles.loop}>{CONTINUITY.loop.map((step, i) => <Text key={step} style={styles.loopStep}>{`${step}${i < CONTINUITY.loop.length - 1 ? ' →' : ''}`}</Text>)}</View>
          <Text style={styles.strong}>{CONTINUITY.close}</Text>
          <Text style={styles.muted}>{CONTINUITY.detail}</Text>
        </Section>

        <Section title={FIVE_ROLES.title}>
          <Text style={styles.muted}>{FIVE_ROLES.framing}</Text>
          {FIVE_ROLES.roles.map((role) => <Expandable key={role.title} title={role.title} body={role.body} />)}
        </Section>

        <Section title={PERSONAS.title}>
          {PERSONAS.personas.map((p) => <Expandable key={p.title} title={p.title} lead={p.thought} body={p.plate} />)}
          <Text style={styles.muted}>{`Also for: ${PERSONAS.alsoFor.join(' · ')}. One life, many games.`}</Text>
        </Section>

        <Section title={INSIDE.title}>
          {INSIDE.parts.map((part) => <Expandable key={part.title} title={part.title} body={part.body} />)}
        </Section>

        <Section title={MODES.title}>
          {MODES.modes.map((mode) => <Expandable key={mode.key} title={mode.title} body={mode.body} />)}
        </Section>

        <Section title={TRACKS.title}>
          <Text style={styles.muted}>{TRACKS.body}</Text>
          <View style={styles.spotlight}>
            <Text style={styles.spotLabel}>{TRACKS.spotlight.label}</Text>
            <Text style={styles.cardTitle}>{TRACKS.spotlight.title}</Text>
            <Text style={styles.body}>{TRACKS.spotlight.body}</Text>
          </View>
          {TRACKS.tracks.filter((t) => t.key !== TRACKS.spotlight.key).map((t) => <Expandable key={t.key} title={t.title} body={t.body} />)}
        </Section>

        <Section title={SITUATIONS.title}>
          {SITUATIONS.rows.map(([when, then]) => (
            <View key={when} style={styles.row}><Text style={styles.rowWhen}>{when}</Text><Text style={styles.rowThen}>{`→ ${then}`}</Text></View>
          ))}
          <Text style={styles.muted}>{SITUATIONS.close}</Text>
        </Section>

        <Section title={WITHOUT_WITH.title}>
          <Expandable title={WITHOUT_WITH.without.label} body={[...WITHOUT_WITH.without.lines, WITHOUT_WITH.without.result].join('\n')} />
          <Expandable title={WITHOUT_WITH.with.label} body={[...WITHOUT_WITH.with.lines, WITHOUT_WITH.with.result].join('\n')} initiallyOpen />
        </Section>

        <Section title={WELCOME_TIERS_TEASER.title}>
          <Text style={styles.body}>{WELCOME_TIERS_TEASER.line}</Text>
          <View style={styles.teaser}><Text style={styles.teaserText}>{WELCOME_TIERS_TEASER.offer}</Text></View>
        </Section>

        <Section title="Your data is yours">
          <Text style={styles.body}>{PRIVACY_LINE}</Text>
          <Pressable accessibilityRole="link" onPress={() => router.push('/settings/privacy')} style={styles.linkWrap}><Text style={styles.link}>{PRIVACY_LINK_LABEL}</Text></Pressable>
        </Section>

        <Pressable accessibilityRole="button" onPress={start} style={({ pressed }) => [styles.cta, pressed && styles.pressed]}><Text style={styles.ctaText}>{CTA_LABEL}</Text></Pressable>
        <PlateLine text={WELCOME_PLATE} />
        <View style={styles.spacer} />
      </ScrollView>
      <View style={styles.sticky}>
        <Pressable accessibilityRole="button" onPress={start} style={({ pressed }) => [styles.cta, pressed && styles.pressed]}><Text style={styles.ctaText}>{CTA_LABEL}</Text></Pressable>
        <Pressable accessibilityRole="link" onPress={() => router.push('/account')} style={styles.linkWrap}><Text style={styles.link}>{HAVE_ACCOUNT_LABEL}</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Expandable({ title, body, lead, initiallyOpen = false }: { title: string; body: string; lead?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen((v) => !v)} style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.chev}>{open ? '−' : '+'}</Text>
      </View>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
      {open ? <Text style={styles.body}>{body}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, gap: spacing.md },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
  headline: { color: colors.ink, fontSize: 36, lineHeight: 42, fontWeight: '900', letterSpacing: -1 },
  sub: { color: colors.inkMuted, fontSize: 17, lineHeight: 25 },
  empty: { backgroundColor: colors.accentSoft, borderRadius: radius.md, padding: spacing.sm },
  emptyText: { color: colors.ink, fontWeight: '700', fontSize: 15, lineHeight: 21 },
  section: { gap: spacing.sm, marginTop: spacing.sm },
  sectionTitle: { color: colors.ink, fontSize: 22, lineHeight: 28, fontWeight: '800' },
  body: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.inkMuted, fontSize: 15, lineHeight: 21 },
  strong: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  bullet: { color: colors.ink, fontSize: 16, lineHeight: 23, fontWeight: '600' },
  loop: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  loopStep: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: spacing.md, gap: 6, minHeight: 48 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 },
  chev: { color: colors.accent, fontSize: 22, fontWeight: '800' },
  lead: { color: colors.inkMuted, fontSize: 15, fontStyle: 'italic' },
  spotlight: { backgroundColor: colors.accentSoft, borderRadius: radius.md, padding: spacing.md, gap: 6, borderWidth: 1, borderColor: '#B7D1C6' },
  spotLabel: { color: colors.accent, fontWeight: '900', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  row: { backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  rowWhen: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  rowThen: { color: colors.accent, fontSize: 15, fontWeight: '800' },
  teaser: { alignSelf: 'flex-start', backgroundColor: colors.warningSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  teaserText: { color: colors.warning, fontWeight: '900' },
  cta: { minHeight: 54, borderRadius: radius.md, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  pressed: { opacity: 0.75 },
  linkWrap: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  link: { color: colors.accent, fontWeight: '800', fontSize: 15 },
  sticky: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  spacer: { height: spacing.lg },
});
