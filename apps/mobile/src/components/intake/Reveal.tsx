import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AREA_LABELS, PILLAR_LABELS, type AreaKey, type PillarName } from '@apm/domain';
import {
  CORE_LAWS,
  FIRST_SEVEN_DAYS,
  agendaArrivalMinutes,
  chosenGoal,
  classifySuggestedArea,
  clockLabel,
  goalOutcome,
  holdingCount,
  optionLabel,
  synthesizeProfile,
  type AnswerValue,
  type IntakeAnswers,
  type IntakeSynthesis,
} from '@apm/planning';
import { Body, Card, CardTitle, KeyValue, Label, Pill, uiStyles } from '../ui';
import { colors, radius, spacing } from '../../theme';
import { BedRoutineCard, MorningCard } from './Interstitials';
import { Chip, Muted, OptionButton, intakeStyles } from './primitives';
import { TRACKS } from '../../content/sell';

const arr = (a: IntakeAnswers, id: string) => (Array.isArray(a[id]) ? (a[id] as string[]) : []);
const MOVE_TARGET: Record<PillarName, AreaKey> = { mind: 'learning', body: 'health_routines', spirit: 'meditation' };

export function useSynthesis(answers: IntakeAnswers): IntakeSynthesis {
  return useMemo(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Date().toISOString().slice(0, 10);
    return synthesizeProfile(answers, { startDate: today, timezone });
  }, [answers]);
}

/** "Building your operating system": a real wait, ≤ 8 s, five lines ticking off (docs/34 §7.3). */
export function BuildingScreen({ work, onDone }: { work: () => Promise<void>; onDone: () => void }) {
  const lines = ['Reading your answers', 'Choosing your one foreground', 'Setting your pillars and floors', 'Picking your Tracks', 'Writing your first 7 days'];
  const [ticked, setTicked] = useState(0);
  const finished = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let reduced = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { reduced = value; }).catch(() => undefined);
    const timers = lines.map((_, i) => setTimeout(() => { if (!cancelled) setTicked(reduced ? lines.length : i + 1); }, 450 * (i + 1)));
    const minimum = new Promise((resolve) => setTimeout(resolve, 450 * lines.length + 200));
    const capped = Promise.race([work().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 8000))]);
    void Promise.all([minimum, capped]).then(() => { if (!cancelled && !finished.current) { finished.current = true; onDone(); } });
    return () => { cancelled = true; timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={intakeStyles.stack}>
      <Text accessibilityRole="header" style={intakeStyles.heading}>Building your operating system</Text>
      {lines.map((line, i) => (
        <Text key={line} style={[styles.tick, i < ticked && styles.tickDone]} accessibilityLabel={`${line}${i < ticked ? ', done' : ''}`}>{`${i < ticked ? '✓' : '○'}  ${line}`}</Text>
      ))}
    </View>
  );
}

function ChangeCard({ title, body, onChange, children }: { title: string; body?: string; onChange?: () => void; children?: React.ReactNode }) {
  return (
    <Card>
      <View style={styles.cardHead}>
        <CardTitle>{title}</CardTitle>
        {onChange ? <Pressable accessibilityRole="button" accessibilityLabel={`Change ${title}`} onPress={onChange} style={styles.change}><Text style={styles.changeText}>Change</Text></Pressable> : null}
      </View>
      {body ? <Body muted>{body}</Body> : null}
      {children}
    </Card>
  );
}

/** The three pillar cards with their areas ("Mind · Business (critical) · Money…"). */
export function PillarCards({ synthesis, onToggleCritical }: { synthesis: IntakeSynthesis; onToggleCritical?: (area: AreaKey, critical: boolean) => void }) {
  return (
    <View style={uiStyles.stack}>
      {synthesis.pillars.pillars.map((pillar) => (
        <Card key={pillar.pillar} tone={pillar.enabled ? 'default' : 'muted'}>
          <View style={uiStyles.row}>
            <CardTitle>{pillar.label}</CardTitle>
            <Pill tone={pillar.enabled ? 'success' : 'neutral'}>{pillar.enabled ? 'On' : 'Off'}</Pill>
          </View>
          {pillar.enabled ? pillar.areas.map((area) => (
            <View key={area.area} style={styles.areaRow}>
              <View style={styles.areaText}>
                <Text style={styles.areaName}>{area.label}</Text>
                {area.critical && area.floor ? <Muted>{`Floor on a hard day: ${area.floor}`}</Muted> : <Muted>Maintained in the background</Muted>}
              </View>
              {onToggleCritical ? (
                <Chip label={area.critical ? 'Critical' : 'Flexible'} selected={area.critical} onPress={() => onToggleCritical(area.area, !area.critical)} />
              ) : area.critical ? <Pill tone="warning">Critical</Pill> : null}
            </View>
          )) : <Muted>Switched off. Untick or tick it on the Pillars detail.</Muted>}
          {synthesis.pillars.keptForForeground === pillar.pillar ? <Muted>Your #1 goal lives here, so this area stays on.</Muted> : null}
        </Card>
      ))}
    </View>
  );
}

export function SummaryScreen({ answers, onSet, onOpen, onPush, saveCard, nameChoices }: {
  answers: IntakeAnswers;
  onSet: (id: string, value: AnswerValue | undefined) => void;
  onOpen: (detail: 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6') => void;
  onPush: (allow: boolean) => void;
  saveCard?: React.ReactNode;
  nameChoices?: boolean;
}) {
  const s = useSynthesis(answers);
  const goal = chosenGoal(answers);
  const [suggestion, setSuggestion] = useState('');
  const suggested = arr(answers, '_suggested_areas');
  const tracksOn = s.tracks.filter((t) => t.on);
  const addSuggestion = () => {
    const text = suggestion.trim();
    if (text.length < 2) return;
    const c = classifySuggestedArea(text);
    onSet('_suggested_areas', [...suggested.filter((e) => !e.startsWith(`${c.label}|`)), `${c.label}|${c.area}`].slice(-5));
    setSuggestion('');
  };
  const move = (entry: string, pillar: PillarName) => {
    const [label] = entry.split('|');
    onSet('_suggested_areas', suggested.map((e) => (e === entry ? `${label}|${MOVE_TARGET[pillar]}` : e)));
  };
  return (
    <View style={intakeStyles.stack}>
      <Text accessibilityRole="header" style={intakeStyles.heading}>Your operating system</Text>
      <Body muted>Built from your answers. Every piece is already decided; tap Change on anything that's wrong.</Body>
      <ChangeCard title="Your one priority" body={`${goal?.label ?? 'Your goal'}${goalOutcome(answers) ? ` (${goalOutcome(answers)})` : ''} · first step: ${String(answers.first_step ?? '—')}`} onChange={() => onOpen('r2')} />
      <ChangeCard title="Your pillars" onChange={() => onOpen('r1')}>
        <PillarCards synthesis={s} />
      </ChangeCard>
      <Card tone="muted">
        <Label>Suggest a pillar</Label>
        <Muted>Something that matters and isn't here yet? APM files it under Mind, Body or Spirit. Move it with one tap.</Muted>
        <TextInput accessibilityLabel="Suggest a pillar" value={suggestion} onChangeText={setSuggestion} onSubmitEditing={addSuggestion} placeholder="e.g. my marriage, guitar, church" placeholderTextColor={colors.inkMuted} style={styles.input} maxLength={60} />
        <OptionButton role="button" label="Add it" selected={false} onPress={addSuggestion} />
        {suggested.map((entry) => {
          const [label, area] = entry.split('|') as [string, AreaKey];
          return (
            <View key={entry} style={uiStyles.stackSm}>
              <Body>{`${label}: ${AREA_LABELS[area] ?? area}`}</Body>
              <View style={intakeStyles.chips}>
                {(['mind', 'body', 'spirit'] as PillarName[]).map((pillar) => <Chip key={pillar} label={`Move to ${PILLAR_LABELS[pillar]}`} selected={false} onPress={() => move(entry, pillar)} />)}
              </View>
            </View>
          );
        })}
      </Card>
      <ChangeCard title="Tracks running in the background" body={tracksOn.map((t) => t.name.replace(' Track', '')).join(' · ')} onChange={() => onOpen('r3')} />
      <ChangeCard title="How APM coaches you" body={`${s.coaching.label} · on Today you can switch mode with one tap`} onChange={() => onOpen('r4')} />
      <ChangeCard title="Your rules" body="Never Miss Twice, No Catch-Up, Minimum Viable Day, plus your settings" onChange={() => onOpen('r4')} />
      <ChangeCard title="Your morning" body={`Agenda arrives at ${s.agendaAt} · ${s.morning.length} steps${s.bedRoutine ? ' · starts with your 10-minute in-bed routine' : ''}`} onChange={() => onOpen('r5')} />
      <Card tone="accent">
        <CardTitle>Let your agenda arrive on its own?</CardTitle>
        <Muted>The one permission that makes this work: no remembering to open the app.</Muted>
        <View style={intakeStyles.chips}>
          <Chip label="Allow notifications" selected={answers.push === true} onPress={() => onPush(true)} />
          <Chip label="Not now" selected={answers.push === false} onPress={() => onPush(false)} />
        </View>
      </Card>
      <ChangeCard title="Your first 7 days" body="Day 1: do only the first item. Day 4: practise a miss." onChange={() => onOpen('r6')} />
      {saveCard}
      {nameChoices !== false ? (
        <Card tone="muted">
          <Label>Name it</Label>
          <View style={intakeStyles.chips}>
            {s.systemNames.map((name) => <Chip key={name} label={name} selected={s.systemName === name} onPress={() => onSet('sysname', name)} />)}
          </View>
        </Card>
      ) : null}
      <Muted>{`Holding ${holdingCount(answers)} things for you. Install takes one tap; if you're offline it finishes as soon as you're back.`}</Muted>
    </View>
  );
}

export function DetailScreen({ id, answers, onSet }: { id: 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6'; answers: IntakeAnswers; onSet: (id: string, value: AnswerValue | undefined) => void }) {
  const s = useSynthesis(answers);
  const heading = (text: string) => <Text accessibilityRole="header" style={intakeStyles.heading}>{text}</Text>;
  if (id === 'r1') {
    const core = Array.isArray(answers.core_pillars) ? (answers.core_pillars as string[]) : ['mind', 'body', 'spirit'];
    return (
      <View style={intakeStyles.stack}>
        {heading('Your pillars')}
        <Body muted>Mind, Body and Spirit are on by default. Untick a pillar to switch it off. Tap an area to switch it between critical and flexible: missing a critical area records a miss; flexible ones never break continuity.</Body>
        <View style={intakeStyles.chips}>
          {(['mind', 'body', 'spirit'] as PillarName[]).map((pillar) => (
            <Chip key={pillar} label={PILLAR_LABELS[pillar]} selected={core.includes(pillar)} onPress={() => onSet('core_pillars', core.includes(pillar) ? core.filter((p) => p !== pillar) : [...core, pillar])} />
          ))}
        </View>
        <PillarCards synthesis={s} onToggleCritical={(area, critical) => onSet(`crit_${area}`, critical)} />
        {s.practices.length ? (
          <Card>
            <CardTitle>What APM supplies for Mind and Spirit</CardTitle>
            {s.practices.map((p) => <Body key={p.key}>{`• ${p.label}: ${p.title} (${p.cadence === 'daily' ? 'daily' : p.cadence === 'few' ? '3 times a week' : 'weekly'}; hard day: ${p.floor.title})`}</Body>)}
          </Card>
        ) : null}
      </View>
    );
  }
  if (id === 'r2') {
    const goal = chosenGoal(answers);
    return (
      <View style={intakeStyles.stack}>
        {heading('Your foreground')}
        <Card tone="accent"><CardTitle>{`${goal?.label ?? 'Your goal'}${goalOutcome(answers) ? ` (${goalOutcome(answers)})` : ''}`}</CardTitle><Muted>{`Target: ${answers.target ? (answers.target === 'none' ? 'no hard date (90-day gates)' : `${String(answers.target)} days`) : '90 days'}`}</Muted></Card>
        <Card>
          {s.plan.gates.map((gate) => <Body key={gate.key}>{`Day ${gate.startDay} to ${gate.endDay} · ${gate.label}: ${gate.outcome}`}</Body>)}
        </Card>
        <Card><Label>First action</Label><Body>{String(answers.first_step ?? s.plan.actions[s.plan.setup[0]?.actionKey ?? '']?.title ?? '—')}</Body><Muted>{`Minutes a day: ${String(answers.minutes ?? 45)}`}</Muted></Card>
        {s.plan.safety.notes.length ? <Card tone="warning">{s.plan.safety.notes.map((note) => <Body key={note}>{note}</Body>)}</Card> : null}
        <Muted>Swap with a background goal later from Goals: it runs Arbitration (leverage, urgency, energy match, compounding, downside).</Muted>
      </View>
    );
  }
  if (id === 'r3') {
    return (
      <View style={intakeStyles.stack}>
        {heading('Your Tracks')}
        <Body muted>Background filters, not tasks. Kept minimal for the first install.</Body>
        {s.tracks.map((track) => (
          <Card key={track.key}>
            <View style={styles.cardHead}>
              <CardTitle>{track.name}</CardTitle>
              <Chip label={track.on ? 'On' : 'Off'} selected={track.on} onPress={() => onSet(`trk_${track.key}`, !track.on)} />
            </View>
            <Muted>{`Because: ${track.reason}`}</Muted>
            {track.key === 'billionaire_mindset' ? <Muted>{TRACKS.spotlight.body}</Muted> : null}
          </Card>
        ))}
      </View>
    );
  }
  if (id === 'r4') {
    const lines = arr(answers, 'lines');
    const sleep = Number(answers.sleep ?? 1350);
    const wake = Number(answers.wake ?? 390);
    return (
      <View style={intakeStyles.stack}>
        {heading('Your operating rules')}
        <Card tone="accent"><Label>Locked laws</Label><Body>{CORE_LAWS.map((law) => law.label).join(' · ')}</Body></Card>
        <Card>
          <Label>How APM coaches you</Label>
          <View style={intakeStyles.chips}>
            {(['gentle', 'direct', 'high_pressure'] as const).map((tone) => <Chip key={tone} label={tone === 'gentle' ? 'Gentle' : tone === 'direct' ? 'Calm and direct' : 'High-Pressure'} selected={s.coaching.tone === tone} onPress={() => onSet('tone', tone)} />)}
          </View>
          {s.coaching.preselected && s.coaching.tone === 'high_pressure' ? <Muted>Pre-selected because the Billionaire High Performance Coach Track fits your game. You can change it any time.</Muted> : null}
          <KeyValue label="Day start" value={optionLabel('start', String(answers.start ?? 'guided'))} />
          <KeyValue label="Scoring" value={optionLabel('scoring', String(answers.scoring ?? 'pillar'))} />
          <KeyValue label="Layout" value={optionLabel('sched', String(answers.sched ?? 'loose_dayparts'))} />
          <KeyValue label="Lines held" value={lines.map((l) => optionLabel('lines', l)).join(', ') || 'none yet'} />
          <KeyValue label="Sleep window" value={`${clockLabel(sleep)} to ${clockLabel(wake)} (${(((wake + 1440 - sleep) % 1440) / 60).toFixed(1)} h, from your two times)`} />
          <KeyValue label="Time zone" value={`${Intl.DateTimeFormat().resolvedOptions().timeZone} (detected)`} />
        </Card>
      </View>
    );
  }
  if (id === 'r5') {
    return (
      <View style={intakeStyles.stack}>
        {heading('Your morning')}
        <Card tone="accent"><CardTitle>{`Agenda arrives at ${clockLabel(agendaArrivalMinutes(answers))}`}</CardTitle></Card>
        <MorningCard answers={answers} compact />
        {s.bedRoutine ? <BedRoutineCard moves={s.bedRoutine.moves} gentle={s.bedRoutine.gentle} note={s.bedRoutine.note} /> : null}
        {s.practices.filter((p) => p.steps.length).map((p) => (
          <Card key={p.key}><Label>{p.label}</Label><CardTitle>{p.title}</CardTitle>{p.steps.map((step) => <Body key={step} muted>{`• ${step}`}</Body>)}</Card>
        ))}
      </View>
    );
  }
  return (
    <View style={intakeStyles.stack}>
      {heading('Your first 7 days')}
      {FIRST_SEVEN_DAYS.map((day) => (
        <Card key={day.day}><Label>{`Day ${day.day} · ${day.objective}`}</Label><Body>{day.day === 5 ? `${day.success} (load check: you said ${String(answers.load ?? 7)}/10 on Day 1)` : day.success}</Body></Card>
      ))}
      <Muted>Week-1 rules: no optimising, no customising, no new projects. Any edit is saved as a draft for Day 8.</Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  tick: { fontSize: 17, color: colors.inkMuted, paddingVertical: 6 },
  tickDone: { color: colors.success, fontWeight: '700' },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  change: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  changeText: { color: colors.accent, fontWeight: '800' },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  areaText: { flex: 1, gap: 2 },
  areaName: { color: colors.ink, fontWeight: '700', fontSize: 16 },
  input: { minHeight: 48, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.ink },
});
