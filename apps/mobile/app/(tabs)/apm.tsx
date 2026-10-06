import { useState } from 'react';
import { TextInput, View } from 'react-native';
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
import { closeCoachSession, sendCoachMessage } from '../../src/api/apmApi';
import { colors, radius, spacing } from '../../src/theme';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { useSession } from '../../src/state/session';

const modeCopy: Record<OperatingModeKey, { label: string; description: string; opening: string }> = {
  standard: { label: 'Standard', description: 'Normal execution. Keep the plan boring and clear.', opening: 'What feels most important to get clear on before you execute?' },
  recovery: { label: 'Recovery', description: 'Reduce scope. Protect continuity. No catch-up.', opening: 'What is the smallest useful thing you can do today without making tomorrow harder?' },
  high_pressure: { label: 'High-Pressure', description: 'Direct challenge for avoidance or a hard decision. No shame, no theatrics.', opening: 'What decision or action are you avoiding right now?' },
  executive_review: { label: 'Executive Review', description: 'Organize what exists and make decisions without adding new projects.', opening: 'What is creating the most noise or ambiguity in your current system?' },
  sprint: { label: 'Sprint', description: 'A bounded high-output mode for a defined objective and short window.', opening: 'What single outcome defines success for this sprint, and what is the next move?' },
  deep_work: { label: 'Deep Work', description: 'Protect one uninterrupted focus block and suppress lower-value noise.', opening: 'What deserves your uninterrupted attention right now?' },
};

type ChatTurn = { role: 'user' | 'apm'; text: string };

export default function ApmScreen() {
  const { graph, todayPlan, setOperatingMode, isDurable } = useLifeGraph();
  const { accessToken } = useSession();
  const [busyMode, setBusyMode] = useState<OperatingModeKey>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [coachingBusy, setCoachingBusy] = useState(false);
  const [closure, setClosure] = useState<string>();
  const activeMode = graph.personalOS?.activeMode ?? todayPlan?.mode ?? 'standard';
  const active = modeCopy[activeMode];

  const changeMode = async (mode: OperatingModeKey) => {
    if (!isDurable || busyMode) return;
    setBusyMode(mode); setError(undefined); setClosure(undefined);
    try {
      await setOperatingMode(mode);
      if (sessionId && accessToken) await closeCoachSession(sessionId, accessToken).catch(() => undefined);
      setSessionId(undefined); setTurns([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change APM mode.');
    } finally { setBusyMode(undefined); }
  };

  const send = async () => {
    const text = message.trim();
    if (!text || !accessToken || coachingBusy) return;
    setCoachingBusy(true); setError(undefined); setMessage(''); setClosure(undefined);
    setTurns((current) => [...current, { role: 'user', text }]);
    try {
      const result = await sendCoachMessage({ message: text, sessionId, mode: activeMode }, accessToken);
      setSessionId(result.sessionId);
      setTurns((current) => [...current, { role: 'apm', text: result.reply }]);
      if (result.closureReady && result.nextAction) setClosure(result.nextAction);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'APM coaching is unavailable. No private-data model route will be used unless it is explicitly approved.');
    } finally { setCoachingBusy(false); }
  };

  const close = async () => {
    if (sessionId && accessToken) await closeCoachSession(sessionId, accessToken).catch(() => undefined);
    setSessionId(undefined); setTurns([]); setClosure(undefined);
  };

  return (
    <Screen eyebrow="APM Coach" title="Your system changes with your state—not your standards." subtitle="Modes change how APM holds the day. Your Personal OS remains the source of truth.">
      <Card tone="accent">
        <Label>Active mode</Label><CardTitle>{active.label}</CardTitle><Body>{active.description}</Body>
        <View style={uiStyles.row}><Pill tone="success">Durable Personal OS</Pill><Pill>{graph.personalOS?.accountability.dayStart === 'hard' ? 'Hard Start' : 'Guided Start'}</Pill></View>
      </Card>

      <SectionTitle>Change mode</SectionTitle>
      <Card>
        <Body muted>Mode changes are explicit. APM does not silently escalate coaching intensity.</Body>
        {(Object.keys(modeCopy) as OperatingModeKey[]).map((mode) => <Button key={mode} label={busyMode === mode ? 'Saving…' : modeCopy[mode].label} variant={activeMode === mode ? 'primary' : 'secondary'} onPress={() => void changeMode(mode)} />)}
      </Card>

      <SectionTitle>Coach</SectionTitle>
      <Card>
        {!turns.length ? <><Label>APM</Label><CardTitle>{active.opening}</CardTitle></> : null}
        {turns.map((turn, index) => <View key={`${turn.role}-${index}`} style={uiStyles.stack}><Label>{turn.role === 'apm' ? 'APM' : 'You'}</Label><Body>{turn.text}</Body></View>)}
        {closure ? <Card tone="accent"><Label>Back to execution</Label><CardTitle>{closure}</CardTitle></Card> : null}
        <TextInput value={message} onChangeText={setMessage} placeholder="Talk to APM…" placeholderTextColor={colors.inkMuted} multiline style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, minHeight: 88, padding: spacing.md, color: colors.ink }} />
        <Button label={coachingBusy ? 'Thinking…' : 'Send'} onPress={() => void send()} />
        {sessionId ? <Button label="Close coaching session" variant="secondary" onPress={() => void close()} /> : null}
        <Body muted>Live coaching fails closed when no privacy-approved model route exists. It never falls back to an unapproved free endpoint.</Body>
      </Card>

      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <SectionTitle>Your background tracks</SectionTitle>
      <Card>{graph.tracks.length ? graph.tracks.filter((track) => track.active).map((track) => <View key={track.id} style={uiStyles.stack}><CardTitle>{track.name}</CardTitle><Body muted>Background decision filter · not a daily task list</Body></View>) : <Body muted>No tracks installed yet. Complete the Personal OS intake to choose them.</Body>}</Card>

      <SectionTitle>Core laws</SectionTitle>
      <Card><Body>Never Miss Twice</Body><Body>Continuity &gt; Intensity</Body><Body>No Catch-Up</Body><Body>No Mid-Day Negotiation</Body><Body>Zeros Are Allowed</Body><Body>Minimum Viable Day</Body></Card>
    </Screen>
  );
}
