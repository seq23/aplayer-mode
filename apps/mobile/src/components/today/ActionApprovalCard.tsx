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
  const suite = reply || move;
  if (action.status !== 'prepared' || !action.requiresApproval) return null;
  const busy = busyId === action.id;
  const timezone = typeof data.timezone === 'string' ? data.timezone : 'UTC';

  return <Card tone="warning">
    <Label tone="warning">{reply ? 'Email reply' : move ? 'Calendar fix' : actionTag(action.domain, action.actionType)}</Label>
    <CardTitle>{reply ? String(data.subject) : move ? String(data.title) : action.reason}</CardTitle>
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
    </> : <Body muted>{TODAY_COPY.approvalBody}</Body>}
    {suite && onReport ? <ReportThis what={reply ? 'draft reply' : 'calendar proposal'} send={onReport} /> : null}
    <Button label={busy ? TODAY_COPY.approvalBusy : suite ? 'Approve' : TODAY_COPY.approvalButton} busy={busy} disabled={Boolean(busyId)} onPress={onApprove} />
    {suite ? <Button label="Reject" variant="secondary" disabled={Boolean(busyId)} onPress={onReject} /> : null}
  </Card>;
}
