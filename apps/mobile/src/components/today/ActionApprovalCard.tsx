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

export function ActionApprovalCard({ action, busyId, onApprove, onReject, onReport, onPermissions, onUndo }: {
  action: ActionRecord;
  busyId?: string;
  onApprove: (editedBody?: string) => void;
  onPermissions?: () => void;
  onUndo?: () => void;
  onReject: () => void;
  onReport?: (reason: CoachReportReason) => Promise<unknown>;
}) {
  const data = action.payload;
  const reply = data.suiteProposal === 'reply';
  const [body, setBody] = useState(() => String(data.body ?? ''));
  const cancel = data.suiteProposal === 'subscription_cancel';
  const move = data.suiteProposal === 'calendar_fix';
  const goalBlock = data.suiteProposal === 'goal_calendar';
  const checklist = data.suiteProposal === 'goal_checklist';
  const missed = data.suiteProposal === 'missed_day';
  const defer = missed || data.suiteProposal === 'hard_day';
  const suite = reply || cancel || move || goalBlock || checklist || defer;
  const label = reply ? 'Email reply' : cancel ? 'Subscription check' : move ? 'Calendar fix' : goalBlock ? 'Time for your goal'
    : checklist ? 'Goal checklist' : missed ? 'Make room on a minimum day' : defer ? 'Take a task off today' : actionTag(action.domain, action.actionType);
  const busy = busyId === action.id;
  const timezone = typeof data.timezone === 'string' ? data.timezone : 'UTC';
  if (suite && (action.status === 'verified' || action.status === 'cancelled')) return <Card>
    <Label>{label}</Label>
    <CardTitle>{action.status === 'cancelled' ? (action.executedAt ? 'Undone' : 'Skipped')
      : reply || cancel ? 'Sent' : move || defer ? 'Moved' : 'Added'}</CardTitle>
    <Body>{action.status === 'cancelled' ? (action.executedAt ? String(data.title) : 'Nothing changed.')
      : reply || cancel ? `To ${String(data.to)}${reply ? ' in the original thread.' : '.'}`
      : move || defer ? `${String(data.title)} · ${time(data.startsAt, timezone, true)}` : String(data.title)}</Body>
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
      <Body muted>Approve to move this block and leave your focus time and other events as they are.</Body>
    </> : goalBlock ? <>
      <KeyValue label="Calendar" value={String(data.account)} />
      <KeyValue label="Time" value={`${time(data.startsAt, timezone, true)} to ${time(data.endsAt, timezone)}`} />
      <Body>{String(data.detail)}</Body>
      <Body muted>Approve to add this block and keep your other calendar events as they are.</Body>
    </> : checklist ? <>
      <Body>{String(data.detail)}</Body>
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
