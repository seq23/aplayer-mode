import { useState } from 'react';
import { Body, Button, Card, CardTitle, ChoiceRow, ErrorState, Label, Screen, SectionTitle, TextField, EmptyState, Toast } from '../src/components/ui';
import { logDiaryEntry } from '../src/api/apmApi';
import { useLifeGraph } from '../src/state/lifeGraph';
import { plainError } from '../src/api/errors';
import { DIARY_KIND_WORDS, shortDate } from '../src/content/words';

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
    } catch (cause) { setError(plainError(cause, 'Not saved. Try again.')); }
    finally { setBusy(false); }
  };

  return (
    <Screen title="Log it. That's all." subtitle="Jot it down and move on. No coaching. Your weekly debrief brings the breakthroughs back.">
      <Card>
        <Label>What kind of entry?</Label>
        <ChoiceRow options={(['diary', 'breakthrough', 'slip'] as const).map((id) => ({ id, label: DIARY_KIND_WORDS[id]! }))} value={kind} onChange={setKind} />
        <TextField value={body} onChangeText={setBody} placeholder="Short bullet points are enough." multiline />
        <Button label={busy ? 'Logging…' : 'Log it'} busy={busy} disabled={!body.trim() && !busy} disabledReason="Write a line first." onPress={() => save()} />
        {kind === 'slip' ? <Body muted>One slip is a data point. The next planned meal or session is the recovery — no compensation.</Body> : null}
      </Card>
      <Toast tone="success" message={reply} />
      {error ? <ErrorState message={error} /> : null}
      <SectionTitle>Recent entries</SectionTitle>
      {graph.diaryEntries.length ? graph.diaryEntries.slice(0, 20).map((entry) => (
        <Card key={entry.id} tone="muted"><Label>{`${shortDate(entry.localDay) || entry.localDay} · ${DIARY_KIND_WORDS[entry.kind] ?? 'Note'}`}</Label><Body>{entry.body}</Body></Card>
      )) : <EmptyState icon="edit-3" title="No entries yet." body="Short bullet points are enough. Entries are filed, not coached." />}
    </Screen>
  );
}
