import { useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import type { OperatingModeKey } from '@apm/domain';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Label,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../src/components/ui';
import { closeCoachSession, sendCoachMessage, type CoachChoice, type CoachReplyView, type ModeChangeRequest } from '../../src/api/apmApi';
import { colors, radius, spacing } from '../../src/theme';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { useSession } from '../../src/state/session';

const MODE_ORDER: OperatingModeKey[] = ['standard', 'high_pressure', 'executive_review', 'sprint', 'recovery', 'deep_work'];
const MODE_LABEL: Record<OperatingModeKey, string> = {
  standard: 'Standard', high_pressure: 'High-Pressure Coaching', executive_review: 'Executive Review', sprint: 'Sprint', recovery: 'Recovery', deep_work: 'Deep Work',
};
const SPRINT_DAYS = [3, 7, 14];
const BLOCK_MINUTES = [25, 50, 90, 120];

type ChatTurn = { role: 'user' | 'apm'; text: string };

const inputStyle = { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, color: colors.ink } as const;

function formatWhen(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function ApmScreen() {
  const { graph, todayPlan, modeState, setOperatingMode, applyModeState, isDurable } = useLifeGraph();
  const { accessToken } = useSession();
  const [busyMode, setBusyMode] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [last, setLast] = useState<CoachReplyView>();
  const [coachingBusy, setCoachingBusy] = useState(false);
  const [pending, setPending] = useState<'sprint' | 'deep_work'>();
  const [focus, setFocus] = useState('');

  const activeMode: OperatingModeKey = modeState?.mode ?? graph.personalOS?.activeMode ?? todayPlan?.mode ?? 'standard';
  const definition = modeState?.definition;

  const resetCoach = () => { setSessionId(undefined); setTurns([]); setLast(undefined); };

  const changeMode = async (request: ModeChangeRequest, key: string) => {
    if (!isDurable || busyMode) return;
    setBusyMode(key); setError(undefined);
    try {
      await setOperatingMode(request);
      if (sessionId && accessToken) await closeCoachSession(sessionId, accessToken).catch(() => undefined);
      resetCoach(); setPending(undefined); setFocus('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change APM mode.');
    } finally { setBusyMode(undefined); }
  };

  const send = async (input: { message?: string; choice?: CoachChoice }, label?: string) => {
    if (!accessToken || coachingBusy) return;
    if (input.choice === 'open_today') { resetCoach(); return; }
    setCoachingBusy(true); setError(undefined);
    const shown = input.message ?? label;
    if (shown) setTurns((current) => [...current, { role: 'user', text: shown }]);
    try {
      const result = await sendCoachMessage({ ...input, sessionId }, accessToken);
      setSessionId(result.sessionId);
      setLast(result);
      setTurns((current) => [...current, { role: 'apm', text: [result.reply, result.prompt.kind === 'question' && !result.prompt.options.length ? result.prompt.text : ''].filter(Boolean).join('\n') }]);
      if (result.modeState) applyModeState(result.modeState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'APM coaching is unavailable right now.');
    } finally { setCoachingBusy(false); }
  };

  const submitMessage = () => {
    const text = message.trim();
    if (!text) return;
    setMessage('');
    void send({ message: text });
  };

  const close = async () => {
    if (sessionId && accessToken) await closeCoachSession(sessionId, accessToken).catch(() => undefined);
    resetCoach();
  };

  const safety = last?.phase === 'safety_stop' ? last.safety : undefined;
  const awaitingOptions = last?.prompt.options.length ? last.prompt : undefined;

  return (
    <Screen eyebrow="APM Coach" title="Your system changes with your state—not your standards." subtitle="Modes change how APM holds the day. Your Personal OS remains the source of truth.">
      <Card tone="accent">
        <Label>Current mode</Label>
        <CardTitle>{definition?.name ?? MODE_LABEL[activeMode]}</CardTitle>
        {definition ? <Body>{definition.purpose}</Body> : null}
        <View style={uiStyles.row}>
          <Pill tone={activeMode === 'recovery' ? 'warning' : activeMode === 'standard' ? 'neutral' : 'success'}>{MODE_LABEL[activeMode]}</Pill>
          {modeState?.endsAt ? <Pill>{activeMode === 'recovery' ? 'Full agenda resumes' : 'Ends'} {formatWhen(modeState.endsAt)}</Pill> : null}
          {modeState?.recoveryLocked ? <Pill tone="warning">Mandatory recovery day</Pill> : null}
        </View>
        {modeState?.focus ? <Body>Focus: {modeState.focus}</Body> : null}
        {modeState?.todayEffect ? <Body muted>Today: {modeState.todayEffect.summary}</Body> : null}
        {definition?.rules.map((rule) => <Body key={rule} muted>• {rule}</Body>)}
        {definition ? <Body muted>Exit: {definition.exitProtocol}</Body> : null}
        {modeState?.canExit ? (
          <Button
            label={busyMode === 'exit' ? 'Saving…' : activeMode === 'sprint' ? 'Declare sprint complete' : activeMode === 'recovery' ? 'Declare my return (resumes tomorrow)' : activeMode === 'deep_work' ? 'End the block early' : `Exit ${MODE_LABEL[activeMode]}`}
            variant="secondary"
            onPress={() => void changeMode({ action: 'exit' }, 'exit')}
          />
        ) : null}
      </Card>

      <SectionTitle>Change mode</SectionTitle>
      <Card>
        <Body muted>Mode changes are explicit and yours. APM never silently escalates coaching intensity.</Body>
        {MODE_ORDER.filter((mode) => mode !== activeMode).map((mode) => (
          <Button
            key={mode}
            label={busyMode === mode ? 'Saving…' : MODE_LABEL[mode]}
            variant="secondary"
            onPress={() => {
              if (mode === 'sprint' || mode === 'deep_work') { setPending(mode); return; }
              void changeMode({ mode }, mode);
            }}
          />
        ))}
        {pending === 'sprint' ? (
          <View style={uiStyles.stack}>
            <Label>Sprint length (max 14 days, recovery day after)</Label>
            {SPRINT_DAYS.map((days) => <Button key={days} label={`${days} days`} onPress={() => void changeMode({ mode: 'sprint', days }, 'sprint')} />)}
          </View>
        ) : null}
        {pending === 'deep_work' ? (
          <View style={uiStyles.stack}>
            <Label>The one task for this block</Label>
            <TextInput value={focus} onChangeText={setFocus} placeholder="e.g. Draft the intro section" placeholderTextColor={colors.inkMuted} style={inputStyle} />
            {BLOCK_MINUTES.map((minutes) => <Button key={minutes} label={`${minutes} minutes`} onPress={() => void changeMode({ mode: 'deep_work', minutes, focus: focus.trim() }, 'deep_work')} />)}
          </View>
        ) : null}
      </Card>

      <SectionTitle>Coach</SectionTitle>
      <Card>
        {!turns.length ? (
          <>
            <Body muted>{activeMode === 'executive_review' ? 'Executive Review organizes what you already know. No new ideas, no questions.' : activeMode === 'deep_work' ? 'Coaching waits until your block ends.' : 'One question at a time. Coaching closes back into your Morning Sequence.'}</Body>
            <Button label={coachingBusy ? 'Starting…' : activeMode === 'executive_review' ? 'Run Executive Review' : 'Start coaching'} onPress={() => void send({})} />
          </>
        ) : null}
        {turns.map((turn, index) => <View key={`${turn.role}-${index}`} style={uiStyles.stack}><Label>{turn.role === 'apm' ? 'APM' : 'You'}</Label><Body>{turn.text}</Body></View>)}

        {last?.morningSequence && last.phase === 'morning_sequence' ? (
          <Card tone="accent"><Label>Morning Sequence</Label>{last.morningSequence.map((step, index) => <Body key={step}>{index + 1}. {step}</Body>)}</Card>
        ) : null}

        {safety ? (
          <Card tone="danger">
            <Label>Support right now</Label>
            {safety.resources.map((resource) => (
              <View key={resource.label} style={uiStyles.stack}>
                <CardTitle>{resource.label}</CardTitle>
                <Body>{resource.detail}</Body>
                {resource.action ? <Button label={resource.action.kind === 'url' ? 'Open' : `Call ${resource.action.value}`} variant="danger" onPress={() => void Linking.openURL(resource.action!.kind === 'url' ? resource.action!.value : `tel:${resource.action!.value}`)} /> : null}
              </View>
            ))}
          </Card>
        ) : null}

        {awaitingOptions ? (
          <View style={uiStyles.stack}>
            <CardTitle>{awaitingOptions.text}</CardTitle>
            {awaitingOptions.options.map((option) => <Button key={option.id} label={option.label} variant={option.id === 'go_deeper' || option.id === 'stay_in_block' ? 'secondary' : 'primary'} onPress={() => void send({ choice: option.id }, option.label)} />)}
          </View>
        ) : null}

        {turns.length && last?.phase !== 'safety_stop' && last?.phase !== 'closed' ? (
          <>
            <TextInput value={message} onChangeText={setMessage} placeholder={last?.phase === 'morning_sequence' ? 'Tell APM when you are done…' : 'Answer APM…'} placeholderTextColor={colors.inkMuted} multiline style={{ ...inputStyle, minHeight: 88 }} />
            <Button label={coachingBusy ? 'Thinking…' : 'Send'} onPress={submitMessage} />
          </>
        ) : null}
        {sessionId ? <Button label={last?.phase === 'closed' || last?.phase === 'safety_stop' ? 'Start a new session' : 'Close coaching session'} variant="secondary" onPress={() => void close()} /> : null}
        {last ? <Body muted>{last.engine === 'model' ? 'Phrased by a privacy-approved model; the structure is APM’s.' : 'Running APM’s built-in BHPC flow — no AI model received your words.'}</Body> : null}
        <Body muted>Coaching is behavioral and decision-focused. It is not therapy, medical, legal or financial advice.</Body>
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>Your background tracks</SectionTitle>
      <Card>{graph.tracks.length ? graph.tracks.filter((track) => track.active).map((track) => <View key={track.id} style={uiStyles.stack}><CardTitle>{track.name}</CardTitle><Body muted>Background decision filter · applied to every coaching turn</Body></View>) : <Body muted>No tracks installed yet. Complete the Personal OS intake to choose them.</Body>}</Card>

      <SectionTitle>Core laws</SectionTitle>
      <Card><Body>Never Miss Twice</Body><Body>Continuity &gt; Intensity</Body><Body>No Catch-Up</Body><Body>No Mid-Day Negotiation</Body><Body>Zeros Are Allowed</Body><Body>Minimum Viable Day</Body></Card>
    </Screen>
  );
}
