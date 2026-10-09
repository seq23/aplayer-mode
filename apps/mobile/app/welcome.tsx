import { useState, type ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  CONTINUITY,
  CTA_LABEL,
  FIVE_ROLES,
  HAVE_ACCOUNT_LABEL,
  HERO,
  HOW_IT_WORKS,
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
import { useConsent } from '../src/state/consent';
import { Body, Button, Card, CardTitle, ChoiceRow, Disclosure, Screen, Eyebrow, Fill, Flow, Heading, Hero, Icon, Label, LinkButton, ListItem, Muted, Pill, PlateLine, Row, Stack, Toast, type IconName } from '../src/components/ui';

/** One icon per role, so the five jobs scan as five people, not five paragraphs. */
const ROLE_ICONS: readonly IconName[] = ['compass', 'list', 'map', 'shield', 'refresh-cw'];

/**
 * The welcome page sells (docs/34 §3, docs/36 H1): the promise first, then how it works,
 * then the pitch in a scannable order. The five jobs, the persona for her game, the six
 * engines and the coaching modes are VISIBLE (one line each), not hidden behind taps; only
 * the long tail (six more Tracks, the advice transcript) folds. A sticky "Start" button,
 * and the CTA again at the end. All copy lives in src/content/sell.ts.
 */
export default function WelcomeScreen() {
  const { startAnonymous } = useSession();
  const { track } = useIntake();
  const { ageConfirmed, healthDecision } = useConsent();
  const { deleted } = useLocalSearchParams<{ deleted?: string }>();
  const [persona, setPersona] = useState<string>(PERSONAS.personas[0].title);
  const shown = PERSONAS.personas.find((p) => p.title === persona) ?? PERSONAS.personas[0];
  const start = () => {
    // 18+ first, then the separate health-data choice; nothing is asked or saved before them.
    if (!ageConfirmed) { router.push('/age'); return; }
    if (!healthDecision) { router.push('/health-consent'); return; }
    // Silent anonymous session (when the project allows it); the draft is saved on this phone either way.
    void startAnonymous().catch(() => false);
    track('onboarding_started', {});
    router.push('/intake');
  };

  return (
    <Screen
      fullBleed
      footer={(
        <>
          <Button label={CTA_LABEL} large onPress={start} />
          <LinkButton role="link" align="center" label={HAVE_ACCOUNT_LABEL} onPress={() => router.push('/account')} />
        </>
      )}
    >
      {deleted === '1' ? <Toast tone="success" message="Your account deletion is under way. Everything is erased within 24 hours, and you are signed out." /> : null}
      <Stack gap="md">
        <Eyebrow>{HERO.eyebrow}</Eyebrow>
        <Hero>{HERO.headline}</Hero>
        <Body muted>{HERO.sub}</Body>
      </Stack>
      <Card tone="accent">
        <Row gap="sm" align="flex-start">
          <Icon name="clock" size={20} tone="accent" />
          <Fill><Body strong>{HERO.emptyLine}</Body></Fill>
        </Row>
      </Card>

      <Section eyebrow="In three steps" title={HOW_IT_WORKS.title}>
        <Flow steps={[...HOW_IT_WORKS.steps]} />
      </Section>

      <Section eyebrow="Why it works" title={CONTINUITY.title}>
        <Body>{CONTINUITY.body}</Body>
        <Row wrap gap="xs">{CONTINUITY.loop.map((step, i) => <Row key={step} gap="xs"><Pill tone="accent">{step}</Pill>{i < CONTINUITY.loop.length - 1 ? <Icon name="arrow-right" size={14} tone="inkMuted" /> : null}</Row>)}</Row>
        <Body strong>{CONTINUITY.close}</Body>
        <Muted>{CONTINUITY.detail}</Muted>
      </Section>

      <Section eyebrow="Five jobs in one" title={FIVE_ROLES.title}>
        <Body muted>{FIVE_ROLES.lead}</Body>
        <Card>
          {FIVE_ROLES.roles.map((role, i) => (
            <Row key={role.title} gap="sm" align="flex-start">
              <Icon name={ROLE_ICONS[i] ?? 'check'} size={20} tone="accent" />
              <Fill>
                <CardTitle>{role.title}</CardTitle>
                <Muted>{role.body}</Muted>
              </Fill>
            </Row>
          ))}
        </Card>
        <Muted>{FIVE_ROLES.framing}</Muted>
      </Section>

      <Section eyebrow="Whatever game you're playing" title={PERSONAS.title}>
        <ChoiceRow options={PERSONAS.personas.map((p) => ({ id: p.title, label: p.title }))} value={persona} onChange={setPersona} />
        <Card tone="feature">
          <Label tone="accent">{shown.title}</Label>
          <CardTitle>{shown.thought}</CardTitle>
          <Row gap="xs" align="flex-start"><Icon name="corner-down-right" size={16} tone="accent" /><Fill><Body>{shown.plate}</Body></Fill></Row>
        </Card>
        <Muted>{`Also for: ${PERSONAS.alsoFor.join(' · ')}. One life, many games.`}</Muted>
      </Section>

      <Section eyebrow="Runs in the background" title={INSIDE.title}>
        <Body muted>{INSIDE.lead}</Body>
        <Card>{INSIDE.parts.map((part) => <ListItem key={part.title} title={part.title} detail={part.body} />)}</Card>
      </Section>

      <Section eyebrow="Coaching" title={MODES.title}>
        <Body muted>{MODES.lead}</Body>
        <Card>{MODES.modes.map((mode) => <ListItem key={mode.key} title={mode.title} detail={mode.body} />)}</Card>
      </Section>

      <Section eyebrow="Tracks" title={TRACKS.title}>
        <Muted>{TRACKS.body}</Muted>
        <Card tone="feature">
          <Label tone="accent">{TRACKS.spotlight.label}</Label>
          <CardTitle>{TRACKS.spotlight.title}</CardTitle>
          <Body>{TRACKS.spotlight.body}</Body>
        </Card>
        <Disclosure icon="layers" title={`The other ${TRACKS.tracks.length - 1} Tracks`} summary={TRACKS.tracks.filter((t) => t.key !== TRACKS.spotlight.key).map((t) => t.title.replace(/ Track$/, '')).join(' · ')}>
          {TRACKS.tracks.filter((t) => t.key !== TRACKS.spotlight.key).map((t) => <ListItem key={t.key} title={t.title} detail={t.body} />)}
        </Disclosure>
      </Section>

      <Section eyebrow="Handled for you" title={SITUATIONS.title}>
        <Card>
          {SITUATIONS.rows.map(([when, then]) => (
            <Stack key={when} gap="xxs">
              <Body strong>{when}</Body>
              <Row gap="xs" align="flex-start"><Icon name="corner-down-right" size={16} tone="accent" /><Fill><Body tone="accent">{then}</Body></Fill></Row>
            </Stack>
          ))}
        </Card>
        <Muted>{SITUATIONS.close}</Muted>
      </Section>

      <Section eyebrow="The difference" title={WITHOUT_WITH.title}>
        <Expandable title={WITHOUT_WITH.without.label} body={[...WITHOUT_WITH.without.lines, WITHOUT_WITH.without.result].join('\n')} />
        <Expandable title={WITHOUT_WITH.with.label} body={[...WITHOUT_WITH.with.lines, WITHOUT_WITH.with.result].join('\n')} initiallyOpen />
      </Section>

      <Section eyebrow="Plans" title={WELCOME_TIERS_TEASER.title}>
        <Card>{WELCOME_TIERS_TEASER.rows.map((row) => <ListItem key={row.title} title={row.title} detail={row.body} />)}</Card>
        <Pill tone="solid">{WELCOME_TIERS_TEASER.offer}</Pill>
      </Section>

      <Section eyebrow="Privacy" title="Your data is yours">
        <Row gap="xs" align="flex-start"><Icon name="lock" size={16} tone="inkMuted" /><Fill><Body>{PRIVACY_LINE}</Body></Fill></Row>
        <LinkButton role="link" label={PRIVACY_LINK_LABEL} onPress={() => router.push('/settings/privacy')} />
      </Section>

      <Button label={CTA_LABEL} large onPress={start} />
      <PlateLine text={WELCOME_PLATE} />
    </Screen>
  );
}

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Eyebrow>{eyebrow}</Eyebrow>
      <Heading>{title}</Heading>
      {children}
    </Stack>
  );
}

function Expandable({ title, body, initiallyOpen = false }: { title: string; body: string; initiallyOpen?: boolean }) {
  return (
    <Disclosure title={title} initiallyOpen={initiallyOpen}>
      <Body>{body}</Body>
    </Disclosure>
  );
}
