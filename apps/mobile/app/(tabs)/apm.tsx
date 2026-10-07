import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
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
import { closeCoachSession, reportCoachReply, sendCoachMessage, type CoachChoice, type CoachReplyView, type CoachReportReason, type ModeChangeRequest } from '../../src/api/apmApi';
import { plainError } from '../../src/api/errors';
import { openExternal } from '../../src/links/external';
import { colors, radius, spacing } from '../../src/theme';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { useSession } from '../../src/state/session';

const MODE_ORDER: OperatingModeKey[] = ['standard', 'high_pressure', 'executive_review', 'sprint', 'recovery', 'deep_work'];
const MODE_LABEL: Record<OperatingModeKey, string> = {
  standard: 'Standard', high_pressure: 'High-Pressure Coaching', executive_review: 'Executive Review', sprint: 'Sprint', recovery: 'Recovery', deep_work: 'Deep Work',
};
const SPRINT_DAYS = [3, 7, 14];
const BLOCK_MINUTES = [25, 50, 90, 120];

type ChatTurn = { role: 'user' | 'apm'; text: string; turnId?: string };
const REPORT_REASONS: Array<{ id: CoachReportReason; label: string }> = [
  { id: 'harmful', label: 'Harmful or unsafe' },
  { id: 'wrong', label: 'Wrong or misleading' },
  { id: 'inappropriate', label: 'Inappropriate' },
  { id: 'other', label: 'Something else' },
];

const inputStyle = { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, color: colors.ink } as const;

function formatWhen(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function ApmScreen() {
  const { graph, todayPlan, todayLoop, modeState, setOperatingMode, applyTodayState, isDurable } = useLifeGraph();
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
  const [reporting, setReporting] = useState<string>();
  const [reported, setReported] = useState<Record<string, true>>({});
  // Deep Work: APM names the one task (today's priority); the person only confirms or edits it.
  const suggestedFocus = todayLoop?.agenda.firstHour.priority?.title ?? todayLoop?.agenda.foregroundPriority?.label ?? todayPlan?.numberOneMove?.title ?? '';

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
      setError(plainError(cause, 'The mode did not change. Try again.'));
    } finally { setBusyMode(undefined); }
  };

  const send = async (input: { message?: string; choice?: CoachChoice }, label?: string) => {
    if (!accessToken || coachingBusy) return;
    if (input.choice === 'open_today') { resetCoach(); router.navigate('/(tabs)/today'); return; }
    setCoachingBusy(true); setError(undefined);
    const shown = input.message ?? label;
    if (shown) setTurns((current) => [...current, { role: 'user', text: shown }]);
    try {
      const result = await sendCoachMessage({ ...input, sessionId }, accessToken);
      setSessionId(result.sessionId);
      setLast(result);
      setTurns((current) => [...current, { role: 'apm', text: [result.reply, result.prompt.kind === 'question' && !result.prompt.options.length ? result.prompt.text : ''].filter(Boolean).join('\n'), ...(result.turnId ? { turnId: result.turnId } : {}) }]);
      if (result.today) applyTodayState(result.today);
    } catch (cause) {
      // A failed send never eats what she typed: the words go back in the box (docs/35 E9).
      if (input.message) {
        setTurns((current) => current.slice(0, -1));
        setMessage(input.message);
      }
      setError(plainError(cause, 'APM coaching is unavailable right now. Your message is still in the box.'));
    } finally { setCoachingBusy(false); }
  };

  const submitMessage = () => {
    const text = message.trim();
    if (!text) return;
    setMessage('');
    void send({ message: text });
  };

  const report = async (turnId: string, reason: CoachReportReason) => {
    if (!accessToken) return;
    setError(undefined);
    try {
      await reportCoachReply({ turnId, reason }, accessToken);
      setReported((current) => ({ ...current, [turnId]: true }));
      setReporting(undefined);
    } catch (cause) { setError(plainError(cause, 'The report did not send. Try again.')); }
  };

  const close = async () => {
    if (sessionId && accessToken) await closeCoachSession(sessionId, accessToken).catch(() => undefined);
    resetCoach();
  };

  const safety = last?.phase === 'safety_stop' ? last.safety : undefined;
  const awaitingOptions = last?.prompt.options.length ? last.prompt : undefined;

  return (
    <Screen eyebrow="APM Coach" title="Your system changes with your state—not your standards." subtitle="Modes change how APM holds the day. Your Personal OS remains the source of truth.">
      <Card>
        <Label>Rulebook</Label>
        <View style={uiStyles.row}>
          <Button label="Diary" variant="secondary" onPress={() => router.push('/diary')} />
          <Button label="Weekly debrief" variant="secondary" onPress={() => router.push('/review')} />
          <Button label="Drafting Room" variant="secondary" onPress={() => router.push('/settings/os')} />
        </View>
      </Card>
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
            <Label>{suggestedFocus ? `The one task for this block: ${suggestedFocus}` : 'The one task for this block'}</Label>
            <TextInput accessibilityLabel="Change the task (optional)" value={focus} onChangeText={setFocus} placeholder={suggestedFocus ? 'Change it (optional)' : 'e.g. Draft the intro section'} placeholderTextColor={colors.inkMuted} style={inputStyle} />
            {BLOCK_MINUTES.map((minutes) => <Button key={minutes} label={`${minutes} minutes`} onPress={() => void changeMode({ mode: 'deep_work', minutes, focus: (focus.trim() || suggestedFocus).slice(0, 300) }, 'deep_work')} />)}
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
        {turns.map((turn, index) => (
          <View key={`${turn.role}-${index}`} style={uiStyles.stack}>
            <Label>{turn.role === 'apm' ? 'APM' : 'You'}</Label>
            <Body>{turn.text}</Body>
            {turn.role === 'apm' && turn.turnId ? (
              reported[turn.turnId] ? <Body muted>Reported. Thank you. A person reviews every report.</Body>
                : reporting === turn.turnId ? (
                  <View style={uiStyles.stack}>
                    <Label>What is wrong with this reply?</Label>
                    {REPORT_REASONS.map((reason) => <Button key={reason.id} label={reason.label} variant="secondary" onPress={() => void report(turn.turnId!, reason.id)} />)}
                    <Button label="Cancel" variant="secondary" onPress={() => setReporting(undefined)} />
                  </View>
                ) : (
                  <Pressable accessibilityRole="button" accessibilityLabel="Report this reply" onPress={() => setReporting(turn.turnId)} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
                    <Text style={{ color: colors.inkMuted, fontWeight: '700' }}>Report this</Text>
                  </Pressable>
                )
            ) : null}
          </View>
        ))}

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
                {resource.action ? <Button label={resource.action.kind === 'url' ? 'Open' : resource.action.kind === 'text' ? `Text ${resource.action.value}` : `Call ${resource.action.value}`} variant="danger" onPress={() => { const action = resource.action!; void openExternal(action.kind === 'url' ? { kind: 'web', url: action.value } : { kind: action.kind, number: action.value }); }} /> : null}
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
