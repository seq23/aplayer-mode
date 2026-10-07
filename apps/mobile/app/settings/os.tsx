import { useState } from 'react';
import { AREA_OPTIONS } from '../../src/content/areas';
import { TRACK_DISPLAY_NAMES, type ActiveTrackKey, type OsChangeField, type AreaKey } from '@apm/domain';
import { Body, Button, Card, CardTitle, Chip, ChoiceRow, EmptyState, ErrorState, KeyValue, Label, Screen, SectionTitle, TextField, Toast, uiStyles } from '../../src/components/ui';
import { TimePicker } from '../../src/components/TimePickerField';
import { View } from 'react-native';
import { applyOsChange, discardOsChange, draftOsChange, type OsChangeInput } from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { describeOsChange } from '../../src/content/osChange';
import { plainError } from '../../src/api/errors';

const FIELDS: Array<{ id: OsChangeField; label: string }> = [
  { id: 'morning_sequence', label: 'Morning sequence' },
  { id: 'day_start', label: 'Hard / Guided start' },
  { id: 'coaching_firmness', label: 'Coaching style' },
  { id: 'coaching_reminder_days', label: 'Coaching check-in days' },
  { id: 'pillar', label: 'Critical pillar + floor' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'track_settings', label: 'Track settings' },
  { id: 'review_day', label: 'Weekly review day' },
  { id: 'recovery_day', label: 'Recovery day' },
  { id: 'hard_boundaries', label: 'Hard boundaries' },
  { id: 'non_negotiables', label: 'Non-negotiables' },
  { id: 'core_values', label: 'Values' },
  { id: 'north_star', label: 'North Star' },
  { id: 'show_seven_day_snapshot', label: '7-day snapshot' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => ({ id: day, label: day.slice(0, 3) }));
const PILLARS = [...AREA_OPTIONS];
const lines = (text: string) => text.split(/\n|,/).map((line) => line.trim()).filter(Boolean);

/** BHPC Chat C, the Drafting Room: draft → review → apply. Nothing is real until applied. */
export default function DraftingRoomScreen() {
  const { graph, perform } = useLifeGraph();
  const [field, setField] = useState<OsChangeField>('morning_sequence');
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<string>();
  const [pillar, setPillar] = useState<AreaKey>('movement');
  const [critical, setCritical] = useState(true);
  const [tracks, setTracks] = useState<ActiveTrackKey[]>(graph.tracks.filter((t) => t.active).map((t) => t.key));
  const [hardStop, setHardStop] = useState(graph.personalOS?.trackSettings.hardStop ?? '');
  const [touchpoint, setTouchpoint] = useState(graph.personalOS?.trackSettings.homeTouchpoint ?? '');
  const [movement, setMovement] = useState(graph.personalOS?.trackSettings.movementFloor ?? '');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const drafts = graph.osChanges.filter((change) => change.status === 'draft');
  const history = graph.osChanges.filter((change) => change.status !== 'draft').slice(0, 10);

  const input = (): OsChangeInput | undefined => {
    switch (field) {
      case 'morning_sequence': case 'hard_boundaries': case 'non_negotiables': case 'core_values': return { field, value: lines(text) };
      case 'north_star': return { field, value: text.trim() };
      case 'coaching_firmness': return choice ? { field, value: choice as 'gentle' | 'direct' | 'high_pressure' } : undefined;
      case 'day_start': return choice ? { field, value: choice as 'guided' | 'hard' } : undefined;
      case 'coaching_reminder_days': return Number(text) ? { field, value: Math.round(Number(text)) } : undefined;
      case 'show_seven_day_snapshot': return choice ? { field, value: choice === 'on' } : undefined;
      case 'review_day': case 'recovery_day': return choice ? { field, value: choice } : undefined;
      case 'pillar': return { field, value: { name: pillar, critical, ...(text.trim() ? { minimumFloor: text.trim() } : {}) } };
      case 'tracks': return { field, value: tracks };
      case 'track_settings': return { field, value: { ...(hardStop ? { hardStop } : {}), ...(touchpoint.trim() ? { homeTouchpoint: touchpoint.trim() } : {}), ...(movement.trim() ? { movementFloor: movement.trim() } : {}) } };
    }
  };
  const run = async (call: () => Promise<void>) => {
    setError(undefined); setMessage(undefined);
    try { await call(); } catch (cause) { setError(plainError(cause, 'Not saved. Try again.')); }
  };
  const draft = () => run(async () => {
    const value = input();
    if (!value) { setError('Choose a value first.'); return; }
    await perform((token) => draftOsChange({ ...value, ...(reason.trim() ? { reason: reason.trim() } : {}) }, token));
    setMessage('Drafted. Review it below, then apply it — or discard it.');
  });

  return (
    <Screen title="Change a rule without redoing the intake." subtitle="Draft first. Nothing becomes real until you apply it, and an applied change starts tomorrow — today's locked agenda stands.">
      <Toast tone="success" message={message} />
      {error ? <ErrorState message={error} /> : null}
      <Card>
        <Label>What do you want to change?</Label>
        <ChoiceRow options={FIELDS} value={field} onChange={(value) => { setField(value); setChoice(undefined); setText(''); }} />
        {['morning_sequence', 'hard_boundaries', 'non_negotiables', 'core_values'].includes(field) ? <TextField label="One per line" value={text} onChangeText={setText} multiline /> : null}
        {field === 'north_star' ? <TextField label="North Star" value={text} onChangeText={setText} multiline /> : null}
        {field === 'coaching_reminder_days' ? <TextField label="Days without coaching before a gentle reminder" value={text} onChangeText={setText} placeholder="7" /> : null}
        {field === 'coaching_firmness' ? <ChoiceRow options={[{ id: 'gentle', label: 'Gentle' }, { id: 'direct', label: 'Direct' }, { id: 'high_pressure', label: 'High pressure' }]} value={choice} onChange={setChoice} /> : null}
        {field === 'day_start' ? <ChoiceRow options={[{ id: 'guided', label: 'Guided Start' }, { id: 'hard', label: 'Hard Start' }]} value={choice} onChange={setChoice} /> : null}
        {field === 'show_seven_day_snapshot' ? <ChoiceRow options={[{ id: 'on', label: 'Show' }, { id: 'off', label: 'Hide' }]} value={choice} onChange={setChoice} /> : null}
        {field === 'review_day' || field === 'recovery_day' ? <ChoiceRow options={WEEKDAYS} value={choice} onChange={setChoice} /> : null}
        {field === 'pillar' ? (
          <>
            <ChoiceRow options={PILLARS} value={pillar} onChange={setPillar} />
            <ChoiceRow options={[{ id: 'yes', label: 'Critical' }, { id: 'no', label: 'Flexible' }]} value={critical ? 'yes' : 'no'} onChange={(value) => setCritical(value === 'yes')} />
            <TextField label="Minimum floor (the smallest version that still counts)" value={text} onChangeText={setText} placeholder="Walk 10 minutes" />
          </>
        ) : null}
        {field === 'tracks' ? (
          <View style={uiStyles.row}>
            {(Object.keys(TRACK_DISPLAY_NAMES) as ActiveTrackKey[]).map((key) => (
              <Chip key={key} label={TRACK_DISPLAY_NAMES[key]} selected={tracks.includes(key)} onPress={() => setTracks((current) => current.includes(key) ? current.filter((k) => k !== key) : [...current, key])} />
            ))}
          </View>
        ) : null}
        {field === 'track_settings' ? (
          <>
            <TimePicker label="Home Front hard stop" value={hardStop} onChange={setHardStop} placeholder="No hard stop" allowClear />
            <TextField label="Home Front daily touchpoint" value={touchpoint} onChangeText={setTouchpoint} placeholder="Bedtime story, phone in another room" />
            <TextField label="Body Foundation movement floor" value={movement} onChangeText={setMovement} placeholder="Walk 10 minutes" />
          </>
        ) : null}
        <TextField label="Why (optional)" value={reason} onChangeText={setReason} />
        <Button label="Draft the change" onPress={() => void draft()} />
      </Card>

      <SectionTitle>Drafts</SectionTitle>
      {drafts.length ? drafts.map((change) => (
        <Card key={change.id} tone="warning">
          <Label>{FIELDS.find((f) => f.id === change.field)?.label ?? change.field}</Label>
          <CardTitle>{describeOsChange(change.field, change.proposed)}</CardTitle>
          {change.reason ? <Body muted>{change.reason}</Body> : null}
          <Button label="Apply (starts tomorrow)" onPress={() => void run(async () => { const state = await perform((token) => applyOsChange(change.id, token)); setMessage(state.message); })} />
          <Button label="Discard" variant="secondary" onPress={() => void run(async () => { await perform((token) => discardOsChange(change.id, token)); })} />
        </Card>
      )) : <EmptyState icon="edit-3" title="No drafts" body="In Week 1 changes can be drafted but not applied: the system stabilizes first." />}

      {history.length ? <SectionTitle>History</SectionTitle> : null}
      {history.map((change) => (
        <Card key={change.id} tone="muted"><KeyValue label={FIELDS.find((f) => f.id === change.field)?.label ?? change.field} value={`${change.status}${change.effectiveFrom ? ` · from ${change.effectiveFrom}` : ''}`} /></Card>
      ))}
    </Screen>
  );
}
