import { useState } from 'react';
import { View } from 'react-native';
import type { CoachReportReason } from '../api/apmApi';
import { plainError } from '../api/errors';
import { Button, ErrorState, Label, LinkButton, Muted, uiStyles } from './ui';

export const REPORT_REASONS: Array<{ id: CoachReportReason; label: string }> = [
  { id: 'harmful', label: 'Harmful or unsafe' },
  { id: 'wrong', label: 'Wrong or misleading' },
  { id: 'inappropriate', label: 'Inappropriate' },
  { id: 'other', label: 'Something else' },
];

/**
 * "Report this" on anything APM writes for the person (App Review Guideline 1.2): coach replies,
 * plan items and Radar items. Tap → pick a reason → `send` stores it; a failure says so in words.
 */
export function ReportThis({ what, send }: { what: string; send: (reason: CoachReportReason) => Promise<unknown> }) {
  const [state, setState] = useState<'idle' | 'choosing' | 'sending' | 'reported'>('idle');
  const [error, setError] = useState<string>();
  const choose = async (reason: CoachReportReason) => {
    setState('sending'); setError(undefined);
    try { await send(reason); setState('reported'); } catch (cause) { setState('choosing'); setError(plainError(cause, 'The report did not send. Try again.')); }
  };
  if (state === 'reported') return <Muted>Reported. Thank you. A person reviews every report.</Muted>;
  if (state === 'idle') return <LinkButton muted accessibilityLabel={`Report this ${what}`} onPress={() => setState('choosing')}>Report this</LinkButton>;
  return (
    <View style={uiStyles.stackSm}>
      <Label>{`What is wrong with this ${what}?`}</Label>
      {REPORT_REASONS.map((reason) => <Button key={reason.id} label={reason.label} variant="secondary" disabled={state === 'sending'} onPress={() => void choose(reason.id)} />)}
      <Button label="Cancel" variant="ghost" onPress={() => { setState('idle'); setError(undefined); }} />
      {error ? <ErrorState message={error} /> : null}
    </View>
  );
}
