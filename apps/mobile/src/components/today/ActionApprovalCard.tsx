import type { ActionRecord } from '@apm/domain';
import type { CoachReportReason } from '../../api/apmApi';
import { TODAY_COPY, actionTag } from '../../content/words';
import { ReportThis } from '../ReportThis';
import { Body, Button, Card, CardTitle, KeyValue, Label } from '../ui';

function time(value: unknown, timezone: string, includeDate = false) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    timeZone: timezone, ...(includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  });
}

export function ActionApprovalCard({ action, busyId, onApprove, onReject, onReport }: {
  action: ActionRecord;
  busyId?: string;
  onApprove: () => void;
  onReject: () => void;
  onReport?: (reason: CoachReportReason) => Promise<unknown>;
}) {
  const data = action.payload;
  const reply = data.suiteProposal === 'reply';
  const move = data.suiteProposal === 'calendar_fix';
  const goalBlock = data.suiteProposal === 'goal_calendar';
  const checklist = data.suiteProposal === 'goal_checklist';
  const missed = data.suiteProposal === 'missed_day';
  const defer = missed || data.suiteProposal === 'hard_day';
  const suite = reply || move || goalBlock || checklist || defer;
  const label = reply ? 'Email reply' : move ? 'Calendar fix' : goalBlock ? 'Time for your goal'
    : checklist ? 'Goal checklist' : missed ? 'Make room on a minimum day' : defer ? 'Take a task off today' : actionTag(action.domain, action.actionType);
  if (action.status !== 'prepared' || !action.requiresApproval) return null;
  const busy = busyId === action.id;
  const timezone = typeof data.timezone === 'string' ? data.timezone : 'UTC';

  return <Card tone="warning">
    <Label tone="warning">{label}</Label>
    <CardTitle>{reply ? String(data.subject) : suite ? String(data.title) : action.reason}</CardTitle>
    {reply ? <>
      <KeyValue label="To" value={String(data.to)} />
      <KeyValue label="From" value={String(data.account)} />
      <Body>{String(data.body)}</Body>
      <Body muted>Approve to send this reply in the original thread and leave the rest of your inbox alone.</Body>
    </> : move ? <>
      <KeyValue label="Calendar" value={String(data.account)} />
      <KeyValue label="Current time" value={`${time(data.originalStartsAt, timezone, true)} to ${time(data.originalEndsAt, timezone)}`} />
      <KeyValue label="Proposed time" value={`${time(data.startsAt, timezone, true)} to ${time(data.endsAt, timezone)}`} />
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
    <Button label={busy ? TODAY_COPY.approvalBusy : suite ? 'Approve' : TODAY_COPY.approvalButton} busy={busy} disabled={Boolean(busyId)} onPress={onApprove} />
    {suite ? <Button label="Reject" variant="secondary" disabled={Boolean(busyId)} onPress={onReject} /> : null}
  </Card>;
}
