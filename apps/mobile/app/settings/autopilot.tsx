import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import type { AutopilotActionClass, AutopilotDoneItem, AutopilotRule, AutopilotRuleConstraints } from '@apm/domain';
import { Body, Button, Card, CardTitle, Chip, ErrorState, KeyValue, ListItem, Pill, Screen, SectionTitle, TextField, uiStyles } from '../../src/components/ui';
import { TimePicker } from '../../src/components/TimePickerField';
import {
  fetchAutopilot,
  fetchAutopilotDone,
  grantAutopilotRule,
  revokeAutopilotRule,
  setAutopilotPaused,
  setAutopilotRuleStatus,
  setPermission,
  undoAutopilotExecution,
  updateAutopilotRule,
  type AutopilotOverview,
} from '../../src/api/apmApi';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { plainError } from '../../src/api/errors';
import { useSession } from '../../src/state/session';

const WEEKDAYS: Array<{ id: number; label: string }> = [
  { id: 1, label: 'Mon' }, { id: 2, label: 'Tue' }, { id: 3, label: 'Wed' }, { id: 4, label: 'Thu' },
  { id: 5, label: 'Fri' }, { id: 6, label: 'Sat' }, { id: 7, label: 'Sun' },
];

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

interface Draft {
  weekdays: number[];
  windowStart: string;
  windowEnd: string;
  maxPerDay: string;
  maxDurationMinutes: string;
  horizonDays: string;
  domains: string;
  expiresInDays: string;
  // email.send
  kinds: string[];
  recipients: string;
  maxPerRecipientPerDay: string;
  templateLabel: string;
  templateSubject: string;
  templateBody: string;
  // reschedule / decline
  keywords: string;
  protectedKeywords: string;
  maxAttendees: string;
  maxShiftDays: string;
  declineNote: string;
  // appointment.book
  providerEmail: string;
  providerLabel: string;
  providerCategory: string;
  appointmentTypes: string;
}

const SEND_KINDS: Array<{ id: string; label: string }> = [
  { id: 'scheduling_reply', label: 'Scheduling replies' },
  { id: 'follow_up', label: 'Follow-ups on what others owe you' },
  { id: 'confirmation', label: 'Confirmations' },
  { id: 'template', label: 'Your templates' },
];

const WINDOWED: AutopilotActionClass[] = ['calendar.create', 'email.draft', 'email.send', 'calendar.reschedule', 'appointment.book'];

const defaultDraft = (actionClass: AutopilotActionClass): Draft => ({
  weekdays: [1, 2, 3, 4, 5],
  windowStart: actionClass === 'calendar.create' ? '06:00' : actionClass === 'calendar.decline' ? '18:00' : '08:00',
  windowEnd: actionClass === 'calendar.create' ? '09:00' : actionClass === 'calendar.decline' ? '23:00' : '18:00',
  maxPerDay: actionClass === 'calendar.create' || actionClass === 'appointment.book' || actionClass === 'subscription.cancel' ? '1' : '3',
  maxDurationMinutes: '60',
  horizonDays: actionClass === 'appointment.book' ? '30' : '7',
  domains: '',
  expiresInDays: '30',
  kinds: ['scheduling_reply', 'follow_up', 'confirmation'],
  recipients: '',
  maxPerRecipientPerDay: '1',
  templateLabel: '',
  templateSubject: '',
  templateBody: '',
  keywords: '',
  protectedKeywords: '',
  maxAttendees: '3',
  maxShiftDays: '2',
  declineNote: '',
  providerEmail: '',
  providerLabel: '',
  providerCategory: 'other',
  appointmentTypes: '',
});

const list = (value: string, lower = true) => value.split(/[,\n]+/).map((item) => (lower ? item.trim().toLowerCase() : item.trim())).filter(Boolean);
const num = (value: string) => Number(value);

function constraintsFrom(actionClass: AutopilotActionClass, draft: Draft, timezone: string): AutopilotRuleConstraints {
  if (WINDOWED.includes(actionClass) || actionClass === 'calendar.decline') {
    if (!draft.weekdays.length) throw new Error('Choose at least one day.');
    if (!HHMM.test(draft.windowStart) || !HHMM.test(draft.windowEnd) || draft.windowEnd <= draft.windowStart) {
      throw new Error('Enter a window like 06:00 – 09:00 that ends after it starts.');
    }
  }
  const windowed = { timezone, weekdays: [...draft.weekdays].sort(), windowStart: draft.windowStart, windowEnd: draft.windowEnd, maxPerDay: num(draft.maxPerDay) };
  const criteria = { matchTitleKeywords: list(draft.keywords), maxAttendees: num(draft.maxAttendees), protectedTitleKeywords: list(draft.protectedKeywords) };
  switch (actionClass) {
    case 'calendar.create':
      return { ...windowed, maxDurationMinutes: num(draft.maxDurationMinutes), horizonDays: num(draft.horizonDays), collision: 'never_overlap_busy' };
    case 'email.draft': {
      const domains = list(draft.domains);
      if (!domains.length) throw new Error('List at least one recipient domain, e.g. school.example.org.');
      return { ...windowed, allowedRecipientDomains: domains };
    }
    case 'email.send': {
      const recipients = list(draft.recipients);
      const domains = list(draft.domains);
      if (!recipients.length && !domains.length) throw new Error('List who Autopilot may write to: addresses and/or domains.');
      if (!draft.kinds.length) throw new Error('Choose at least one kind of message.');
      const hasTemplate = draft.templateSubject.trim() && draft.templateBody.trim();
      const kinds = draft.kinds.filter((kind) => kind !== 'template' || hasTemplate) as NonNullable<AutopilotRuleConstraints['allowedKinds']>;
      return {
        ...windowed, maxPerRecipientPerDay: num(draft.maxPerRecipientPerDay), allowedKinds: kinds, allowedRecipients: recipients, allowedRecipientDomains: domains,
        templates: hasTemplate && kinds.includes('template')
          ? [{ id: 'template-1', label: draft.templateLabel.trim() || 'My template', subject: draft.templateSubject.trim(), body: draft.templateBody }]
          : [],
      };
    }
    case 'calendar.reschedule':
      return { ...windowed, ...criteria, horizonDays: num(draft.horizonDays), maxShiftDays: num(draft.maxShiftDays), collision: 'never_overlap_busy' };
    case 'calendar.decline':
      return {
        timezone, maxPerDay: num(draft.maxPerDay), horizonDays: num(draft.horizonDays), ...criteria,
        boundaries: [{ weekdays: [...draft.weekdays].sort(), start: draft.windowStart, end: draft.windowEnd }],
        ...(draft.declineNote.trim() ? { declineNote: draft.declineNote.trim() } : {}),
      };
    case 'appointment.book': {
      const types = list(draft.appointmentTypes, false);
      if (!draft.providerEmail.trim() || !draft.providerLabel.trim() || !types.length) throw new Error('Name the provider, their booking email and the appointment types you allow.');
      return {
        ...windowed, horizonDays: num(draft.horizonDays),
        providers: [{ email: draft.providerEmail.trim().toLowerCase(), label: draft.providerLabel.trim(), category: draft.providerCategory, appointmentTypes: types }],
      };
    }
    case 'subscription.cancel': {
      const domains = list(draft.domains);
      if (!domains.length) throw new Error('List the provider domains whose cancellation address Autopilot may write to.');
      return { timezone, maxPerDay: num(draft.maxPerDay), allowedProviderDomains: domains };
    }
  }
}

function expiryFrom(days: string): string {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('Rules last 1–90 days; renew to extend.');
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

function describe(rule: AutopilotRule): string {
  const c = rule.constraints;
  const days = WEEKDAYS.filter((d) => (c.weekdays ?? []).includes(d.id)).map((d) => d.label).join(' ');
  const when = c.windowStart ? `${days} · ${c.windowStart}–${c.windowEnd} (${c.timezone})` : `(${c.timezone})`;
  switch (rule.actionClass) {
    case 'calendar.create':
      return `${when} · ≤${c.maxDurationMinutes} min · up to ${c.maxPerDay}/day · next ${c.horizonDays} days · never over busy time`;
    case 'email.draft':
      return `${when} · up to ${c.maxPerDay}/day · only to ${(c.allowedRecipientDomains ?? []).join(', ')} · drafts only`;
    case 'email.send':
      return `${when} · ${(c.allowedKinds ?? []).join(', ')} · only to ${[...(c.allowedRecipients ?? []), ...(c.allowedRecipientDomains ?? [])].join(', ')} · up to ${c.maxPerDay}/day, ${c.maxPerRecipientPerDay}/person`;
    case 'calendar.reschedule':
      return `${when} · flexible or matching "${(c.matchTitleKeywords ?? []).join(', ')}" · within ${c.maxShiftDays} days · never focus blocks or your main goal's time`;
    case 'calendar.decline':
      return `Declines invitations in ${(c.boundaries ?? []).map((b) => `${b.start}–${b.end}`).join(', ')} · with a polite note · never your own meetings or protected blocks`;
    case 'appointment.book':
      return `${when} · ${(c.providers ?? []).map((p) => `${p.label}: ${p.appointmentTypes.join(', ')}`).join(' · ')} · FREE bookings only`;
    case 'subscription.cancel':
      return `Cancels by email at ${(c.allowedProviderDomains ?? []).join(', ')} · up to ${c.maxPerDay}/day · never signs up, upgrades or pays`;
  }
}

export default function AutopilotScreen() {
  const { accessToken } = useSession();
  const { graph } = useLifeGraph();
  const timezone = graph.identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [overview, setOverview] = useState<AutopilotOverview>();
  const [drafts, setDrafts] = useState<Record<AutopilotActionClass, Draft>>(() => ({
    'calendar.create': defaultDraft('calendar.create'),
    'email.draft': defaultDraft('email.draft'),
    'email.send': defaultDraft('email.send'),
    'calendar.reschedule': defaultDraft('calendar.reschedule'),
    'calendar.decline': defaultDraft('calendar.decline'),
    'appointment.book': defaultDraft('appointment.book'),
    'subscription.cancel': defaultDraft('subscription.cancel'),
  }));
  const [done, setDone] = useState<AutopilotDoneItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [next, today] = await Promise.all([fetchAutopilot(accessToken), fetchAutopilotDone(accessToken).catch(() => ({ items: [] as AutopilotDoneItem[] }))]);
      setOverview(next);
      setDone(today.items);
    }
    catch (cause) { setError(plainError(cause, 'Autopilot did not load. Check your connection and try again.')); }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined);
    try { await work(); await load(); }
    catch (cause) { setError(plainError(cause, 'That did not go through. Try again.')); }
    finally { setBusy(false); }
  };

  const patchDraft = (actionClass: AutopilotActionClass, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [actionClass]: { ...current[actionClass], ...patch } }));

  if (!overview) {
    return (
      <Screen title="Standing authority, inside your rules." subtitle="Loading your rules…">
        {error ? <Card tone="danger"><Body>{error}</Body><Button label="Try again" variant="secondary" onPress={() => { setError(undefined); void load(); }} /></Card> : null}
      </Screen>
    );
  }

  const { autopilot } = overview;
  if (!autopilot.entitled) {
    return (
      <Screen title="Standing authority, inside your rules." subtitle="Autopilot lets APM handle approved recurring work without asking each time—only inside rules you write and can revoke.">
        <Card tone="warning">
          <CardTitle>Autopilot is not active on this account.</CardTitle>
          <Body muted>Standing rules need an active Autopilot plan, enforced by the server and database. Even then, the plan grants nothing on its own: you choose each rule, its limits and how long it lasts.</Body>
          <Button label="View plans" onPress={() => router.push('/settings/plan')} />
        </Card>
        <Card>
          <CardTitle>Your retained rules</CardTitle>
          <Body muted>Any rules and run history you created before stay visible in Privacy & AI → Your Data and are included in export.</Body>
          <Button label="Your Data" variant="secondary" onPress={() => router.push('/settings/privacy/data')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title="Standing authority, inside your rules." subtitle="APM acts without asking each time only where you have written a rule. Every run is audited and revocable; each one tells you whether it can be undone.">
      {error ? <ErrorState message={error} /> : null}

      <Card tone={autopilot.masterPaused ? 'warning' : 'accent'}>
        <View style={uiStyles.row}>
          <CardTitle>{autopilot.masterPaused ? 'Autopilot is paused' : 'Autopilot is on'}</CardTitle>
          <Pill tone={autopilot.masterPaused ? 'warning' : undefined}>{autopilot.masterPaused ? 'paused' : 'on'}</Pill>
        </View>
        <Body muted>One switch stops every standing rule at once. Pausing always works, even if your plan changes.</Body>
        <Button
          label={autopilot.masterPaused ? 'Resume Autopilot' : 'Pause all Autopilot'}
          variant={autopilot.masterPaused ? 'primary' : 'secondary'}
          onPress={() => void act(() => setAutopilotPaused(!autopilot.masterPaused, accessToken!))}
        />
      </Card>

      <SectionTitle>Done today</SectionTitle>
      {done.length ? done.map((item) => (
        <Card key={item.executionId ?? item.actionId} tone={item.kind === 'stopped' ? 'warning' : item.status === 'failed' ? 'danger' : 'default'}>
          <View style={uiStyles.row}>
            <CardTitle>{item.summary}</CardTitle>
            <Pill tone={item.kind === 'stopped' || item.status === 'failed' ? 'warning' : undefined}>{item.kind === 'stopped' ? 'needs you' : item.status}</Pill>
          </View>
          <KeyValue label="When" value={new Date(item.at).toLocaleTimeString()} />
          {item.stoppedReason === 'payment_required' ? <Body muted>It asked for a card or deposit, so APM stopped. It is waiting in your life areas for your decision.</Body> : null}
          {item.stoppedReason === 'needs_user' ? <Body muted>This provider has no emailed cancellation route. APM prepared it; finishing it is yours.</Body> : null}
          {item.failureCode ? <KeyValue label="Failure" value={item.failureCode} /> : null}
          {item.canUndo && item.executionId
            ? <Button label="Undo" variant="secondary" onPress={() => void act(() => undoAutopilotExecution(item.executionId!, accessToken!))} />
            : null}
          <Body muted>{item.undoLabel}</Body>
        </Card>
      )) : <Card><Body muted>Nothing on Autopilot yet today. Every run lands here with Undo, or a clear "can't undo".</Body></Card>}

      <SectionTitle>Kill switches</SectionTitle>
      <Card>
        <Body muted>Three switches stop Autopilot, and stopping never needs your plan: the master pause above, each rule's own pause or revoke below, and a per-class switch the APM server holds. A class stays off until it passes security and runtime proof.</Body>
        {overview.supported.map((policy) => {
          const cls = autopilot.classes.find((c) => c.actionClass === policy.actionClass);
          return <KeyValue key={policy.actionClass} label={policy.label} value={cls?.activationStatus === 'active' ? 'Class on' : 'Class off · awaiting proof'} />;
        })}
      </Card>

      {overview.supported.map((policy) => {
        const cls = autopilot.classes.find((c) => c.actionClass === policy.actionClass);
        const rule = autopilot.rules.find((r) => r.actionClass === policy.actionClass && r.status !== 'revoked');
        const permissionLevel = overview.permissions.find((p) => p.actionClass === policy.actionClass)?.autonomyLevel ?? 0;
        const draft = drafts[policy.actionClass];
        const expired = rule ? Date.parse(rule.expiresAt) <= Date.now() : false;
        return (
          <View key={policy.actionClass} style={uiStyles.stack}>
            <SectionTitle>{policy.label}</SectionTitle>
            <Card>
              <KeyValue label="Activation" value={cls?.activationStatus === 'active' ? 'Active' : 'Built · waiting on runtime proof'} />
              <KeyValue label="Your permission" value={permissionLevel === 5 ? 'Level 5 · Autopilot' : `Level ${permissionLevel}`} />
              <KeyValue label="Undo" value={policy.reversible ? 'Available' : "Can't undo"} />
              <Body muted>{policy.undoLabel}</Body>
              {cls?.activationStatus !== 'active' ? (
                <Body muted>You can set the rule now. APM will not act on it until this action class passes security and runtime proof.</Body>
              ) : null}
            </Card>

            {rule ? (
              <Card tone={rule.status === 'paused' || expired ? 'warning' : 'default'}>
                <View style={uiStyles.row}>
                  <CardTitle>Your rule</CardTitle>
                  <Pill tone={rule.status === 'active' && !expired ? undefined : 'warning'}>{expired ? 'expired' : rule.status}</Pill>
                </View>
                <Body>{describe(rule)}</Body>
                <KeyValue label="Expires" value={new Date(rule.expiresAt).toLocaleDateString()} />
                {rule.lastExecutedAt ? <KeyValue label="Last run" value={new Date(rule.lastExecutedAt).toLocaleString()} /> : null}
                {rule.status === 'active'
                  ? <Button label="Pause this rule" variant="secondary" onPress={() => void act(() => setAutopilotRuleStatus(rule.id, 'pause', rule.version, accessToken!))} />
                  : !expired ? <Button label="Resume this rule" onPress={() => void act(() => setAutopilotRuleStatus(rule.id, 'resume', rule.version, accessToken!))} /> : null}
                <Button label="Renew for 30 days" variant="secondary" onPress={() => void act(() => updateAutopilotRule(rule.id, { expectedVersion: rule.version, expiresAt: expiryFrom('30') }, accessToken!))} />
                <Button label="Revoke rule" variant="secondary" onPress={() => void act(() => revokeAutopilotRule(rule.id, accessToken!))} />
              </Card>
            ) : (
              <Card>
                <CardTitle>Write a standing rule</CardTitle>
                <Body muted>Days</Body>
                <View style={uiStyles.row}>
                  {WEEKDAYS.map((day) => {
                    const on = draft.weekdays.includes(day.id);
                    return (
                      <Chip key={day.id} label={day.label} selected={on} onPress={() => patchDraft(policy.actionClass, { weekdays: on ? draft.weekdays.filter((d) => d !== day.id) : [...draft.weekdays, day.id] })} />
                    );
                  })}
                </View>
                <Body muted>{policy.actionClass === 'calendar.decline' ? 'Your boundary: invitations in this window on these days are declined' : 'When APM may act'}</Body>
                {(WINDOWED.includes(policy.actionClass) || policy.actionClass === 'calendar.decline') ? (
                  <>
                    <TimePicker label="Window start" value={draft.windowStart} onChange={(v) => patchDraft(policy.actionClass, { windowStart: v })} placeholder="Choose a start time" />
                    <TimePicker label="Window end" value={draft.windowEnd} onChange={(v) => patchDraft(policy.actionClass, { windowEnd: v })} placeholder="Choose an end time" />
                  </>
                ) : null}
                <TextField value={draft.maxPerDay} onChangeText={(v) => patchDraft(policy.actionClass, { maxPerDay: v })} placeholder="Most per day" keyboardType="number-pad" />
                {policy.actionClass === 'calendar.create' ? (
                  <>
                    <TextField value={draft.maxDurationMinutes} onChangeText={(v) => patchDraft(policy.actionClass, { maxDurationMinutes: v })} placeholder="Longest block · minutes" keyboardType="number-pad" />
                    <TextField value={draft.horizonDays} onChangeText={(v) => patchDraft(policy.actionClass, { horizonDays: v })} placeholder="How far ahead · days" keyboardType="number-pad" />
                    <Body muted>APM will never place a block over busy, tentative or out-of-office time.</Body>
                  </>
                ) : null}
                {policy.actionClass === 'email.draft' ? (
                  <>
                    <TextField value={draft.domains} onChangeText={(v) => patchDraft(policy.actionClass, { domains: v })} autoCapitalize="none" placeholder="Allowed recipient domains · comma separated" />
                    <Body muted>Drafts only: they wait in your mailbox for you.</Body>
                  </>
                ) : null}
                {policy.actionClass === 'email.send' ? (
                  <>
                    <View style={uiStyles.row}>
                      {SEND_KINDS.map((kind) => {
                        const on = draft.kinds.includes(kind.id);
                        return (
                          <Chip key={kind.id} label={kind.label} selected={on} onPress={() => patchDraft(policy.actionClass, { kinds: on ? draft.kinds.filter((k) => k !== kind.id) : [...draft.kinds, kind.id] })} />
                        );
                      })}
                    </View>
                    <TextField value={draft.recipients} onChangeText={(v) => patchDraft(policy.actionClass, { recipients: v })} autoCapitalize="none" placeholder="Allowed people · email addresses, comma separated" />
                    <TextField value={draft.domains} onChangeText={(v) => patchDraft(policy.actionClass, { domains: v })} autoCapitalize="none" placeholder="Allowed domains · comma separated (optional)" />
                    <TextField value={draft.maxPerRecipientPerDay} onChangeText={(v) => patchDraft(policy.actionClass, { maxPerRecipientPerDay: v })} placeholder="Most per person per day (1–3)" keyboardType="number-pad" />
                    {draft.kinds.includes('template') ? (
                      <>
                        <TextField value={draft.templateLabel} onChangeText={(v) => patchDraft(policy.actionClass, { templateLabel: v })} placeholder="Template name · e.g. Birthday" />
                        <TextField value={draft.templateSubject} onChangeText={(v) => patchDraft(policy.actionClass, { templateSubject: v })} placeholder="Template subject" />
                        <TextField value={draft.templateBody} onChangeText={(v) => patchDraft(policy.actionClass, { templateBody: v })} placeholder="Template message · sent exactly as written" multiline />
                      </>
                    ) : null}
                    <Body muted>Only these kinds, only to these people. Follow-ups chase only what someone else owes you. A sent message can't be undone.</Body>
                  </>
                ) : null}
                {policy.actionClass === 'calendar.reschedule' || policy.actionClass === 'calendar.decline' ? (
                  <>
                    <TextField value={draft.keywords} onChangeText={(v) => patchDraft(policy.actionClass, { keywords: v })} autoCapitalize="none" placeholder="Also match titles containing · e.g. 1:1, sync" />
                    <TextField value={draft.maxAttendees} onChangeText={(v) => patchDraft(policy.actionClass, { maxAttendees: v })} placeholder="Only meetings with at most N attendees" keyboardType="number-pad" />
                    <TextField value={draft.protectedKeywords} onChangeText={(v) => patchDraft(policy.actionClass, { protectedKeywords: v })} autoCapitalize="none" placeholder="Never touch titles containing · e.g. board, interview" />
                    <TextField value={draft.horizonDays} onChangeText={(v) => patchDraft(policy.actionClass, { horizonDays: v })} placeholder="How far ahead · days" keyboardType="number-pad" />
                    {policy.actionClass === 'calendar.reschedule'
                      ? <TextField value={draft.maxShiftDays} onChangeText={(v) => patchDraft(policy.actionClass, { maxShiftDays: v })} placeholder="Move at most N days" keyboardType="number-pad" />
                      : <TextField value={draft.declineNote} onChangeText={(v) => patchDraft(policy.actionClass, { declineNote: v })} placeholder="Your polite note (optional; a kind default is used)" multiline />}
                    <Body muted>Only events you mark flexible or that match these words. Focus blocks and your main goal's time are never moved or declined.</Body>
                  </>
                ) : null}
                {policy.actionClass === 'appointment.book' ? (
                  <>
                    <TextField value={draft.providerLabel} onChangeText={(v) => patchDraft(policy.actionClass, { providerLabel: v })} placeholder="Provider · e.g. Riverside Clinic" />
                    <TextField value={draft.providerEmail} onChangeText={(v) => patchDraft(policy.actionClass, { providerEmail: v })} autoCapitalize="none" placeholder="Their booking email" />
                    <TextField value={draft.appointmentTypes} onChangeText={(v) => patchDraft(policy.actionClass, { appointmentTypes: v })} placeholder="Appointment types you allow · e.g. annual check-up" />
                    <TextField value={draft.horizonDays} onChangeText={(v) => patchDraft(policy.actionClass, { horizonDays: v })} placeholder="How far ahead · days" keyboardType="number-pad" />
                    <Body muted>FREE bookings only. Anything asking for a card or deposit stops and waits for you. Medical visits are scheduling only — APM never makes a clinical choice.</Body>
                  </>
                ) : null}
                {policy.actionClass === 'subscription.cancel' ? (
                  <>
                    <TextField value={draft.domains} onChangeText={(v) => patchDraft(policy.actionClass, { domains: v })} autoCapitalize="none" placeholder="Provider domains · e.g. streamco.com" />
                    <Body muted>Saves money, never spends it: a fixed cancellation email, or a prepared request when the provider has no emailed route. Never signs up, upgrades or enters payment details.</Body>
                  </>
                ) : null}
                <TextField value={draft.expiresInDays} onChangeText={(v) => patchDraft(policy.actionClass, { expiresInDays: v })} placeholder="Rule lasts · days (max 90)" keyboardType="number-pad" />
                <Body muted>Granting sets this permission to level 5 and creates the rule. Your plan alone never does this.</Body>
                <Button
                  label={busy ? 'Saving…' : 'Grant standing authority'}
                  onPress={() => void act(async () => {
                    const constraints = constraintsFrom(policy.actionClass, draft, timezone);
                    const expiresAt = expiryFrom(draft.expiresInDays);
                    if (permissionLevel !== 5) await setPermission(policy.domain, policy.actionClass, 5, accessToken!);
                    await grantAutopilotRule({ actionClass: policy.actionClass, constraints, expiresAt }, accessToken!);
                  })}
                />
              </Card>
            )}
          </View>
        );
      })}

      <SectionTitle>Earlier Autopilot runs</SectionTitle>
      {autopilot.executions.length ? autopilot.executions.slice(0, 20).map((run) => (
        <Card key={run.id}>
          <View style={uiStyles.row}>
            <CardTitle>{overview.supported.find((p) => p.actionClass === run.actionClass)?.label ?? run.actionClass}</CardTitle>
            <Pill tone={run.status === 'failed' ? 'warning' : undefined}>{run.status}</Pill>
          </View>
          {run.proposedStartsAt ? <KeyValue label="When" value={new Date(run.proposedStartsAt).toLocaleString()} /> : null}
          <KeyValue label="Ran" value={new Date(run.claimedAt).toLocaleString()} />
          {run.failureCode ? <KeyValue label="Failure" value={run.failureCode} /> : null}
          {run.status === 'verified' && overview.supported.find((p) => p.actionClass === run.actionClass)?.reversible
            ? <Button label="Undo" variant="secondary" onPress={() => void act(() => undoAutopilotExecution(run.id, accessToken!))} />
            : run.status === 'verified' ? <Body muted>Can't undo.</Body> : null}
        </Card>
      )) : <Card><Body muted>No Autopilot runs yet. Every run is recorded in Activity.</Body></Card>}

      <SectionTitle>Never on Autopilot</SectionTitle>
      <Card>
        {overview.neverStanding.map((item) => <ListItem key={item.match} title={item.match} detail={item.reason} />)}
      </Card>
    </Screen>
  );
}
