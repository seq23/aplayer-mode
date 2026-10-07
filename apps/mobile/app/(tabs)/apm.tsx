import { useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import type { OperatingModeKey } from '@apm/domain';
import {
  AnswerCard,
  Body,
  Button,
  Card,
  CardTitle,
  ChoiceRow,
  Disclosure,
  Divider,
  ErrorState,
  Heading,
  Label,
  LinkButton,
  ListItem,
  ListRow,
  Muted,
  Pill,
  Row,
  Screen,
  TextField,
  uiStyles,
} from '../../src/components/ui';
import { closeCoachSession, reportCoachReply, sendCoachMessage, type CoachChoice, type CoachReplyView, type CoachReportReason, type ModeChangeRequest } from '../../src/api/apmApi';
import { plainError } from '../../src/api/errors';
import { openExternal } from '../../src/links/external';
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
    <Screen eyebrow="APM Coach" title="Your system changes with your state, not your standards." subtitle="Modes change how APM holds the day. Your Personal OS remains the source of truth.">
      {/* One clear primary (docs/35 U8): the current mode and one way into coaching. Everything else is tucked below. */}
      <Card tone="feature">
        <Row justify="space-between" gap="xs">
          <Label tone="accent">Current mode</Label>
          {modeState?.recoveryLocked ? <Pill tone="warning">Mandatory recovery day</Pill> : null}
        </Row>
        <Heading>{definition?.name ?? MODE_LABEL[activeMode]}</Heading>
        {definition ? <Body muted>{definition.purpose}</Body> : null}
        {modeState?.endsAt ? <Pill>{`${activeMode === 'recovery' ? 'Full agenda resumes' : 'Ends'} ${formatWhen(modeState.endsAt)}`}</Pill> : null}
        {modeState?.focus ? <Body>Focus: {modeState.focus}</Body> : null}
        {modeState?.todayEffect ? <Body muted>Today: {modeState.todayEffect.summary}</Body> : null}
        {!turns.length ? (
          <>
            <Body muted>{activeMode === 'executive_review' ? 'Executive Review organizes what you already know. No new ideas, no questions.' : activeMode === 'deep_work' ? 'Coaching waits until your block ends.' : 'One question at a time. Coaching closes back into your Morning Sequence.'}</Body>
            <Button label={coachingBusy ? 'Starting…' : activeMode === 'executive_review' ? 'Run Executive Review' : 'Start coaching'} large icon="message-circle" onPress={() => void send({})} />
          </>
        ) : null}
      </Card>

      {turns.length ? (
        <Card>
          {turns.map((turn, index) => (
            <View key={`${turn.role}-${index}`} style={uiStyles.stackSm}>
              <Label tone={turn.role === 'apm' ? 'accent' : 'inkMuted'}>{turn.role === 'apm' ? 'APM' : 'You'}</Label>
              <Body>{turn.text}</Body>
              {turn.role === 'apm' && turn.turnId ? (
                reported[turn.turnId] ? <Muted>Reported. Thank you. A person reviews every report.</Muted>
                  : reporting === turn.turnId ? (
                    <View style={uiStyles.stackSm}>
                      <Label>What is wrong with this reply?</Label>
                      {REPORT_REASONS.map((reason) => <Button key={reason.id} label={reason.label} variant="secondary" onPress={() => void report(turn.turnId!, reason.id)} />)}
                      <Button label="Cancel" variant="ghost" onPress={() => setReporting(undefined)} />
                    </View>
                  ) : (
                    <LinkButton muted accessibilityLabel="Report this reply" onPress={() => setReporting(turn.turnId)}>Report this</LinkButton>
                  )
              ) : null}
              {index < turns.length - 1 ? <Divider /> : null}
            </View>
          ))}

          {last?.morningSequence && last.phase === 'morning_sequence' ? (
            <Card tone="accent"><Label>Morning Sequence</Label>{last.morningSequence.map((step, index) => <Body key={step}>{index + 1}. {step}</Body>)}</Card>
          ) : null}

          {safety ? (
            <Card tone="danger">
              <Label tone="danger">Support right now</Label>
              {safety.resources.map((resource) => (
                <View key={resource.label} style={uiStyles.stackSm}>
                  <CardTitle>{resource.label}</CardTitle>
                  <Body>{resource.detail}</Body>
                  {resource.action ? <Button label={resource.action.kind === 'url' ? 'Open' : resource.action.kind === 'text' ? `Text ${resource.action.value}` : `Call ${resource.action.value}`} variant="destructive" onPress={() => { const action = resource.action!; void openExternal(action.kind === 'url' ? { kind: 'web', url: action.value } : { kind: action.kind, number: action.value }); }} /> : null}
                </View>
              ))}
            </Card>
          ) : null}

          {awaitingOptions ? (
            <View style={uiStyles.stackSm}>
              <CardTitle>{awaitingOptions.text}</CardTitle>
              {awaitingOptions.options.map((option) => <Button key={option.id} label={option.label} variant={option.id === 'go_deeper' || option.id === 'stay_in_block' ? 'secondary' : 'primary'} onPress={() => void send({ choice: option.id }, option.label)} />)}
            </View>
          ) : null}

          {last?.phase !== 'safety_stop' && last?.phase !== 'closed' ? (
            <>
              <TextField value={message} onChangeText={setMessage} accessibilityLabel="Your reply to APM" placeholder={last?.phase === 'morning_sequence' ? 'Tell APM when you are done…' : 'Answer APM…'} multiline />
              <Button label={coachingBusy ? 'Thinking…' : 'Send'} icon="send" onPress={submitMessage} />
            </>
          ) : null}
          {sessionId ? <Button label={last?.phase === 'closed' || last?.phase === 'safety_stop' ? 'Start a new session' : 'Close coaching session'} variant="ghost" onPress={() => void close()} /> : null}
          {last ? <Muted>{last.engine === 'model' ? 'Phrased by a privacy-approved model; the structure is APM’s.' : 'Running APM’s built-in BHPC flow: no AI model received your words.'}</Muted> : null}
        </Card>
      ) : null}

      {error ? <ErrorState message={error} /> : null}

      <Disclosure icon="sliders" title="Other modes" summary="Sprint, Deep Work, Recovery and more. Explicit and yours.">
        <Body muted>Mode changes are explicit and yours. APM never silently escalates coaching intensity.</Body>
        {definition?.rules.length ? <Label>{`${definition.name} rules`}</Label> : null}
        {definition?.rules.map((rule) => <Body key={rule} muted>• {rule}</Body>)}
        {definition ? <Body muted>Exit: {definition.exitProtocol}</Body> : null}
        {modeState?.canExit ? (
          <Button
            label={busyMode === 'exit' ? 'Saving…' : activeMode === 'sprint' ? 'Declare sprint complete' : activeMode === 'recovery' ? 'Declare my return (resumes tomorrow)' : activeMode === 'deep_work' ? 'End the block early' : `Exit ${MODE_LABEL[activeMode]}`}
            variant="secondary"
            onPress={() => void changeMode({ action: 'exit' }, 'exit')}
          />
        ) : null}
        {MODE_ORDER.filter((mode) => mode !== activeMode).map((mode) => (
          <AnswerCard
            key={mode}
            role="button"
            label={busyMode === mode ? 'Saving…' : MODE_LABEL[mode]}
            selected={pending === mode}
            onPress={() => {
              if (mode === 'sprint' || mode === 'deep_work') { setPending(mode); return; }
              void changeMode({ mode }, mode);
            }}
          />
        ))}
        {pending === 'sprint' ? (
          <View style={uiStyles.stackSm}>
            <Label>Sprint length (max 14 days, recovery day after)</Label>
            <ChoiceRow options={SPRINT_DAYS.map((days) => ({ id: days, label: `${days} days` }))} onChange={(days) => void changeMode({ mode: 'sprint', days }, 'sprint')} />
          </View>
        ) : null}
        {pending === 'deep_work' ? (
          <View style={uiStyles.stackSm}>
            <Label>{suggestedFocus ? `The one task for this block: ${suggestedFocus}` : 'The one task for this block'}</Label>
            <TextField accessibilityLabel="Change the task (optional)" value={focus} onChangeText={setFocus} placeholder={suggestedFocus ? 'Change it (optional)' : 'e.g. Draft the intro section'} />
            <ChoiceRow options={BLOCK_MINUTES.map((minutes) => ({ id: minutes, label: `${minutes} minutes` }))} onChange={(minutes) => void changeMode({ mode: 'deep_work', minutes, focus: (focus.trim() || suggestedFocus).slice(0, 300) }, 'deep_work')} />
          </View>
        ) : null}
      </Disclosure>

      <Disclosure icon="book-open" title="Your rulebook" summary="Diary, weekly debrief, Drafting Room, Tracks and the core laws">
        <ListRow icon="edit-3" title="Diary" detail="File it without coaching" onPress={() => router.push('/diary')} />
        <ListRow icon="bar-chart-2" title="Weekly debrief" detail="Review the week on your review day" onPress={() => router.push('/review')} />
        <ListRow icon="tool" title="Drafting Room" detail="Change a rule without redoing the setup" onPress={() => router.push('/settings/os')} />
        <Label>Your background tracks</Label>
        {graph.tracks.length ? graph.tracks.filter((track) => track.active).map((track) => <ListItem key={track.id} title={track.name} detail="Background decision filter · applied to every coaching turn" />) : <Muted>No tracks installed yet. Complete the Personal OS intake to choose them.</Muted>}
        <Label>Core laws</Label>
        {['Never Miss Twice', 'Continuity > Intensity', 'No Catch-Up', 'No Mid-Day Negotiation', 'Zeros Are Allowed', 'Minimum Viable Day'].map((law) => <ListItem key={law} title={law} />)}
      </Disclosure>

      <Muted>Coaching is behavioral and decision-focused. It is not therapy, medical, legal or financial advice.</Muted>
    </Screen>
  );
}
