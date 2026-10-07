import type { ReactNode } from 'react';
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
import { Body, Button, Card, CardTitle, Disclosure, Screen, Eyebrow, Fill, Heading, Hero, Icon, Label, LinkButton, ListItem, Muted, Pill, PlateLine, Row, Stack, Toast } from '../src/components/ui';

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
          <Icon name="battery-charging" size={20} tone="accent" />
          <Fill><Body strong>{HERO.emptyLine}</Body></Fill>
        </Row>
      </Card>
      <Section title={HERO.definitionTitle}>
        {HERO.definition.map((line) => <ListItem key={line} title={line} />)}
        <Muted>{HERO.notThis}</Muted>
      </Section>

      <Section title={CONTINUITY.title}>
        <Body>{CONTINUITY.body}</Body>
        <Row wrap gap="xs">{CONTINUITY.loop.map((step, i) => <Row key={step} gap="xs"><Pill tone="accent">{step}</Pill>{i < CONTINUITY.loop.length - 1 ? <Icon name="arrow-right" size={14} tone="inkMuted" /> : null}</Row>)}</Row>
        <Body strong>{CONTINUITY.close}</Body>
        <Muted>{CONTINUITY.detail}</Muted>
      </Section>

      <Section title={FIVE_ROLES.title}>
        <Muted>{FIVE_ROLES.framing}</Muted>
        {FIVE_ROLES.roles.map((role) => <Expandable key={role.title} title={role.title} body={role.body} />)}
      </Section>

      <Section title={PERSONAS.title}>
        {PERSONAS.personas.map((p) => <Expandable key={p.title} title={p.title} lead={p.thought} body={p.plate} />)}
        <Muted>{`Also for: ${PERSONAS.alsoFor.join(' · ')}. One life, many games.`}</Muted>
      </Section>

      <Section title={INSIDE.title}>
        {INSIDE.parts.map((part) => <Expandable key={part.title} title={part.title} body={part.body} />)}
      </Section>

      <Section title={MODES.title}>
        {MODES.modes.map((mode) => <Expandable key={mode.key} title={mode.title} body={mode.body} />)}
      </Section>

      <Section title={TRACKS.title}>
        <Muted>{TRACKS.body}</Muted>
        <Card tone="feature">
          <Label tone="accent">{TRACKS.spotlight.label}</Label>
          <CardTitle>{TRACKS.spotlight.title}</CardTitle>
          <Body>{TRACKS.spotlight.body}</Body>
        </Card>
        {TRACKS.tracks.filter((t) => t.key !== TRACKS.spotlight.key).map((t) => <Expandable key={t.key} title={t.title} body={t.body} />)}
      </Section>

      <Section title={SITUATIONS.title}>
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

      <Section title={WITHOUT_WITH.title}>
        <Expandable title={WITHOUT_WITH.without.label} body={[...WITHOUT_WITH.without.lines, WITHOUT_WITH.without.result].join('\n')} />
        <Expandable title={WITHOUT_WITH.with.label} body={[...WITHOUT_WITH.with.lines, WITHOUT_WITH.with.result].join('\n')} initiallyOpen />
      </Section>

      <Section title={WELCOME_TIERS_TEASER.title}>
        <Body>{WELCOME_TIERS_TEASER.line}</Body>
        <Pill tone="solid">{WELCOME_TIERS_TEASER.offer}</Pill>
      </Section>

      <Section title="Your data is yours">
        <Row gap="xs" align="flex-start"><Icon name="lock" size={16} tone="inkMuted" /><Fill><Body>{PRIVACY_LINE}</Body></Fill></Row>
        <LinkButton role="link" label={PRIVACY_LINK_LABEL} onPress={() => router.push('/settings/privacy')} />
      </Section>

      <Button label={CTA_LABEL} large onPress={start} />
      <PlateLine text={WELCOME_PLATE} />
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Heading>{title}</Heading>
      {children}
    </Stack>
  );
}

function Expandable({ title, body, lead, initiallyOpen = false }: { title: string; body: string; lead?: string; initiallyOpen?: boolean }) {
  return (
    <Disclosure title={title} summary={lead} initiallyOpen={initiallyOpen}>
      {lead ? <Muted>{lead}</Muted> : null}
      <Body>{body}</Body>
    </Disclosure>
  );
}
