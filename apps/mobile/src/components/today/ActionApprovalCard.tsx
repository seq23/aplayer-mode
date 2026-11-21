import { useState } from 'react';
import type { ActionRecord } from '@apm/domain';
import type { CoachReportReason } from '../../api/apmApi';
import { TODAY_COPY, actionTag } from '../../content/words';
import { ReportThis } from '../ReportThis';
import { Body, Button, Card, CardTitle, KeyValue, Label, TextField } from '../ui';

function time(value: unknown, timezone: string, includeDate = false) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    timeZone: timezone, ...(includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  });
}

export function ActionApprovalCard({ action, busyId, onApprove, onReject, onReport, onPermissions, onUndo, timezoneHint }: {
  action: ActionRecord;
  /** Her timezone, for Autopilot moves (their ledger row carries none). */
  timezoneHint?: string;
  busyId?: string;
  onApprove: (editedBody?: string) => void;
  onPermissions?: () => void;
  onUndo?: () => void;
  onReject: () => void;
  onReport?: (reason: CoachReportReason) => Promise<unknown>;
}) {
  // An Autopilot move (her standing rule acted, no tap): shown from the ledger's composed write.
  const autopilotMove = action.idempotencyKey.startsWith('autopilot:suite:clear_day:');
  const composed = (action.payload.composed ?? {}) as Record<string, unknown>;
  const data = autopilotMove ? { ...composed, suiteProposal: 'clear_day', timezone: action.payload.timezone ?? timezoneHint } : action.payload;
  const reply = data.suiteProposal === 'reply';
  const [body, setBody] = useState(() => String(data.body ?? ''));
  const cancel = data.suiteProposal === 'subscription_cancel';
  const clear = data.suiteProposal === 'clear_day';
  const move = data.suiteProposal === 'calendar_fix' || clear;
  const others = typeof data.others === 'number' ? data.others : 0;
  const goalBlock = data.suiteProposal === 'goal_calendar';
  const checklist = data.suiteProposal === 'goal_checklist';
  const missed = data.suiteProposal === 'missed_day';
  const defer = missed || data.suiteProposal === 'hard_day';
  const suite = reply || cancel || move || goalBlock || checklist || defer;
  const label = autopilotMove ? 'Cleared for your minimum day' : reply ? 'Email reply' : cancel ? 'Subscription check' : clear ? 'Clear today to your minimum day' : move ? 'Calendar fix' : goalBlock ? 'Time for your goal'
    : checklist ? 'Goal checklist' : missed ? 'Make room on a minimum day' : defer ? 'Take a task off today' : actionTag(action.domain, action.actionType);
  const busy = busyId === action.id;
  const timezone = typeof data.timezone === 'string' ? data.timezone : 'UTC';
  // The goal step's finished output (the server always sends it); never printed as "undefined".
  const detail = typeof data.detail === 'string' && data.detail.trim() ? data.detail.trim() : undefined;
  // Autopilot tried and the calendar did not take it: say so plainly, never "done".
  if (autopilotMove && action.status === 'failed') return <Card tone="warning">
    <Label tone="warning">{label}</Label>
    <CardTitle>Not moved</CardTitle>
    <Body>{`${String(data.title)} is still at ${time(data.originalStartsAt, timezone)}. Your calendar didn't accept the change, so nothing else was moved.`}</Body>
  </Card>;
  if (suite && (action.status === 'verified' || action.status === 'cancelled')) return <Card>
    <Label>{label}</Label>
    <CardTitle>{action.status === 'cancelled' ? (action.executedAt || autopilotMove ? 'Undone' : 'Skipped')
      : reply || cancel ? 'Sent' : autopilotMove ? 'Moved by Autopilot' : move || defer ? 'Moved' : 'Added'}</CardTitle>
    <Body>{action.status === 'cancelled' ? (action.executedAt ? String(data.title) : 'Nothing changed.')
      : reply || cancel ? `To ${String(data.to)}${reply ? ' in the original thread.' : '.'}`
      : move || defer ? `${String(data.title)} · ${time(data.startsAt, timezone, true)}` : String(data.title)}</Body>
    {autopilotMove && action.status === 'verified' ? <Body muted>Off today so the day fits your minimum. Anyone invited was sent the new time.</Body> : null}
    {move && action.status === 'verified' && onUndo && Date.parse(String(data.originalStartsAt)) > Date.now()
      ? <Button label="Undo" variant="secondary" disabled={Boolean(busyId)} onPress={onUndo} /> : null}
  </Card>;
  if (action.status !== 'prepared' || !action.requiresApproval) return null;
  const canApprove = !suite || action.approvalAvailable === true;

  return <Card tone="warning">
    <Label tone="warning">{label}</Label>
    <CardTitle>{reply ? String(data.subject) : suite ? String(data.title) : action.reason}</CardTitle>
    {reply ? <>
      <KeyValue label="To" value={String(data.to)} />
      <KeyValue label="From" value={String(data.account)} />
      <Label>AI draft</Label>
      <TextField multiline label="Reply draft" value={body} onChangeText={setBody} maxLength={1000} editable={!busy} />
      <Body muted>Approve to send this reply in the original thread and leave the rest of your inbox alone.</Body>
    </> : cancel ? <>
      <Label>AI finding</Label>
      <Body>{action.reason}</Body>
      <KeyValue label="To" value={String(data.to)} />
      <KeyValue label="From" value={String(data.account)} />
      <Body muted>Approve to email a cancellation request and leave payments and account settings alone.</Body>
    </> : move ? <>
      <KeyValue label="Calendar" value={String(data.account)} />
      <KeyValue label="Current time" value={`${time(data.originalStartsAt, timezone, true)} to ${time(data.originalEndsAt, timezone)}`} />
      <KeyValue label="Proposed time" value={`${time(data.startsAt, timezone, true)} to ${time(data.endsAt, timezone)}`} />
      {typeof data.clash === 'string' ? <Body>{data.clash}</Body> : null}
      {clear ? <Body muted>{others
        ? `Approve to move it off today and send the new time to the ${others === 1 ? 'other person' : `${others} other people`} invited. Fixed events stay where they are.`
        : 'Approve to move it off today so the day fits your minimum. Fixed events stay where they are.'}</Body>
        : <Body muted>Approve to move this block and leave your focus time and other events as they are.</Body>}
    </> : goalBlock ? <>
      <KeyValue label="Calendar" value={String(data.account)} />
      <KeyValue label="Time" value={`${time(data.startsAt, timezone, true)} to ${time(data.endsAt, timezone)}`} />
      {detail ? <Body>{detail}</Body> : null}
      <Body muted>Approve to add this block and keep your other calendar events as they are.</Body>
    </> : checklist ? <>
      {detail ? <Body>{detail}</Body> : null}
      <Body muted>Approve to add this to your goal checklist and leave bookings and purchases in your hands.</Body>
    </> : defer ? <>
      <KeyValue label="Current slot" value={time(data.originalStartsAt, timezone, true) + (data.originalEndsAt ? ` to ${time(data.originalEndsAt, timezone)}` : '')} />
      <KeyValue label="New slot" value={time(data.startsAt, timezone, true) + (data.endsAt ? ` to ${time(data.endsAt, timezone)}` : '')} />
      <Body muted>Approve to move this task in Life areas and keep your deadlines and calendar as they are.</Body>
    </> : <Body muted>{TODAY_COPY.approvalBody}</Body>}
    {suite && onReport ? <ReportThis what={reply ? 'draft reply' : move ? 'calendar proposal' : 'proposal'} send={onReport} /> : null}
    {canApprove ? <Button label={busy ? TODAY_COPY.approvalBusy : suite ? 'Approve' : TODAY_COPY.approvalButton} busy={busy} disabled={Boolean(busyId) || (reply && !body.trim())} onPress={() => onApprove(reply ? body : undefined)} />
      : <><Label>Prepare only</Label><Body muted>Check your action permissions and connected account before approving.</Body>
        {onPermissions ? <Button label="Action permissions" variant="secondary" onPress={onPermissions} /> : null}</>}
    {suite ? <Button label="Reject" variant="secondary" disabled={Boolean(busyId)} onPress={onReject} /> : null}
  </Card>;
}
