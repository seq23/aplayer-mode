import { useState } from 'react';
import { Body, Button, Card, CardTitle, ChoiceRow, Label, Screen, SectionTitle, TextField } from '../src/components/ui';
import { logDiaryEntry } from '../src/api/apmApi';
import { useLifeGraph } from '../src/state/lifeGraph';

/** BHPC silent logging: a diary entry is filed and answered with "Logged." — no coaching. */
export default function DiaryScreen() {
  const { graph, perform } = useLifeGraph();
  const [kind, setKind] = useState<'diary' | 'breakthrough' | 'slip'>('diary');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy || !body.trim()) return;
    setBusy(true); setError(undefined); setReply(undefined);
    try {
      const state = await perform((token) => logDiaryEntry({ kind, body: body.trim() }, token));
      setReply(state.reply); setBody('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Not saved.'); }
    finally { setBusy(false); }
  };

  return (
    <Screen eyebrow="Diary" title="Log it. That's all." subtitle="Entries are filed, not coached. Your weekly debrief brings breakthroughs back for review.">
      <Card>
        <Label>What kind of entry?</Label>
        <ChoiceRow options={[{ id: 'diary', label: 'Diary' }, { id: 'breakthrough', label: 'Breakthrough' }, { id: 'slip', label: 'Slip' }]} value={kind} onChange={setKind} />
        <TextField value={body} onChangeText={setBody} placeholder="Short bullet points are enough." multiline />
        <Button label={busy ? 'Logging…' : 'Log it'} onPress={() => void save()} />
        {kind === 'slip' ? <Body muted>One slip is a data point. The next planned meal or session is the recovery — no compensation.</Body> : null}
      </Card>
      {reply ? <Card tone="accent"><CardTitle>{reply}</CardTitle></Card> : null}
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      <SectionTitle>Recent entries</SectionTitle>
      {graph.diaryEntries.length ? graph.diaryEntries.slice(0, 20).map((entry) => (
        <Card key={entry.id} tone="muted"><Label>{`${entry.localDay} · ${entry.kind}`}</Label><Body>{entry.body}</Body></Card>
      )) : <Card tone="muted"><Body muted>No entries yet.</Body></Card>}
    </Screen>
  );
}
