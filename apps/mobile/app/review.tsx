import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, CardTitle, ErrorState, KeyValue, Label, LoadingState, Screen, SectionTitle, TextField } from '../src/components/ui';
import { completeWeeklyReview, fetchWeeklyDebrief, type WeeklyDebriefView } from '../src/api/apmApi';
import { useLifeGraph } from '../src/state/lifeGraph';
import { useSession } from '../src/state/session';
import { plainError } from '../src/api/errors';
import { shortDate } from '../src/content/words';

/** BHPC Prompt #7: Execution Score, Foreground Focus, Friction Analysis, One Adjustment. */
export default function WeeklyReviewScreen() {
  const { accessToken } = useSession();
  const { perform } = useLifeGraph();
  const [debrief, setDebrief] = useState<WeeklyDebriefView>();
  const [adjustment, setAdjustment] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoadFailed(false); setError(undefined);
    void fetchWeeklyDebrief(accessToken).then((result) => { setDebrief(result.debrief); setAdjustment((current) => current || result.debrief.suggestedAdjustment?.text || ''); }).catch((cause: unknown) => { setLoadFailed(true); setError(plainError(cause, 'The debrief did not load.')); });
  }, [accessToken]);
  useEffect(() => { load(); }, [load]);

  // One record per tap: a second tap while saving, or after it is recorded, does nothing (docs/35 E11).
  const finish = async () => {
    if (busy || done) return;
    setBusy(true); setError(undefined);
    try { await perform((token) => completeWeeklyReview(adjustment.trim() || undefined, token)); setDone(true); }
    catch (cause) { setError(plainError(cause, 'Not saved. Try again.')); }
    finally { setBusy(false); }
  };

  return (
    <Screen title="Your week, in five minutes." subtitle={debrief?.executiveReview.open ?? "Here's what you already know that still makes you better:"}>
      {error ? <ErrorState message={error} /> : null}
      {debrief ? (
        <>
          <Card tone="accent">
            <Label>{`How the week went · ${shortDate(debrief.weekStart)} to ${shortDate(debrief.weekEnd)}`}</Label>
            <CardTitle>{`${debrief.executionScore.counted} of 7 days counted (${debrief.executionScore.percent}%)`}</CardTitle>
            <KeyValue label="Full days" value={String(debrief.executionScore.fullDays)} />
            <KeyValue label="Light days (they count)" value={String(debrief.executionScore.mvdDays)} />
            <KeyValue label="Misses" value={String(debrief.executionScore.misses)} />
            <KeyValue label="Not closed" value={String(debrief.executionScore.unclosed)} />
          </Card>
          <Card>
            <Label>Your main goal</Label>
            <CardTitle>{debrief.foregroundFocus.label ?? 'No main goal yet'}</CardTitle>
            <Body>{`You did its daily step on ${debrief.foregroundFocus.daysWithForegroundDone} of 7 days.`}</Body>
          </Card>
          <Card>
            <Label>What got in the way</Label>
            {debrief.friction.map((line) => <Body key={line}>{`• ${line}`}</Body>)}
            {debrief.trackSignals.map((signal) => <Body key={signal.code} muted>{`• ${signal.message}`}</Body>)}
          </Card>
          <Card tone="muted">
            <Label>Diary</Label>
            <Body>{debrief.diaryQuestion}</Body>
            {debrief.diary.filter((entry) => entry.kind === 'breakthrough').map((entry) => <Body key={`${entry.localDay}-${entry.body}`}>{`★ ${entry.body}`}</Body>)}
            <Button label="Open the Diary" variant="secondary" onPress={() => router.push('/diary')} />
          </Card>
          <SectionTitle>One adjustment for next week</SectionTitle>
          <Card>
            {debrief.suggestedAdjustment ? <Label>APM suggests</Label> : null}
            {debrief.suggestedAdjustment ? <Body muted>{`Why: ${debrief.suggestedAdjustment.reason}`}</Body> : null}
            <TextField label="Your adjustment" value={adjustment} onChangeText={setAdjustment} multiline placeholder="e.g. Move the long walk to Saturday mornings" />
            <Body muted>{debrief.adjustmentPrompt}</Body>
            <Button label={done ? 'Debrief recorded' : busy ? 'Recording…' : 'Record the debrief'} disabled={done || busy} onPress={() => void finish()} />
            {done ? <Button label="Draft that change in the Drafting Room" variant="secondary" onPress={() => router.push('/settings/os')} /> : null}
          </Card>
          <Card tone="muted"><Body>{debrief.executiveReview.close}</Body></Card>
        </>
      ) : loadFailed ? <Card><Button label="Try again" onPress={load} /></Card> : <LoadingState label="Loading your week…" />}
    </Screen>
  );
}
