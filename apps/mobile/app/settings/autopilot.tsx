import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AutopilotActionClass, AutopilotRule, AutopilotRuleConstraints } from '@apm/domain';
import { Body, Button, Card, CardTitle, KeyValue, ListItem, Pill, Screen, SectionTitle, uiStyles } from '../../src/components/ui';
import { colors, radius, spacing } from '../../src/theme';
import {
  fetchAutopilot,
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
}

const defaultDraft = (actionClass: AutopilotActionClass): Draft => actionClass === 'calendar.create'
  ? { weekdays: [1, 2, 3, 4, 5], windowStart: '06:00', windowEnd: '09:00', maxPerDay: '1', maxDurationMinutes: '60', horizonDays: '7', domains: '', expiresInDays: '30' }
  : { weekdays: [1, 2, 3, 4, 5], windowStart: '08:00', windowEnd: '18:00', maxPerDay: '3', maxDurationMinutes: '', horizonDays: '', domains: '', expiresInDays: '30' };

function constraintsFrom(actionClass: AutopilotActionClass, draft: Draft, timezone: string): AutopilotRuleConstraints {
  if (!draft.weekdays.length) throw new Error('Choose at least one day.');
  if (!HHMM.test(draft.windowStart) || !HHMM.test(draft.windowEnd) || draft.windowEnd <= draft.windowStart) {
    throw new Error('Enter a window like 06:00 – 09:00 that ends after it starts.');
  }
  const base = { timezone, weekdays: [...draft.weekdays].sort(), windowStart: draft.windowStart, windowEnd: draft.windowEnd, maxPerDay: Number(draft.maxPerDay) };
  if (actionClass === 'calendar.create') {
    return { ...base, maxDurationMinutes: Number(draft.maxDurationMinutes), horizonDays: Number(draft.horizonDays), collision: 'never_overlap_busy' };
  }
  const domains = draft.domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) throw new Error('List at least one recipient domain, e.g. school.example.org.');
  return { ...base, allowedRecipientDomains: domains };
}

function expiryFrom(days: string): string {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('Rules last 1–90 days; renew to extend.');
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

function describe(rule: AutopilotRule): string {
  const c = rule.constraints;
  const days = WEEKDAYS.filter((d) => c.weekdays.includes(d.id)).map((d) => d.label).join(' ');
  const scope = rule.actionClass === 'calendar.create'
    ? `≤${c.maxDurationMinutes} min · up to ${c.maxPerDay}/day · next ${c.horizonDays} days · never over busy time`
    : `up to ${c.maxPerDay}/day · only to ${(c.allowedRecipientDomains ?? []).join(', ')} · drafts only, never sent`;
  return `${days} · ${c.windowStart}–${c.windowEnd} (${c.timezone}) · ${scope}`;
}

export default function AutopilotScreen() {
  const { accessToken } = useSession();
  const { graph } = useLifeGraph();
  const timezone = graph.identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [overview, setOverview] = useState<AutopilotOverview>();
  const [drafts, setDrafts] = useState<Record<AutopilotActionClass, Draft>>({
    'calendar.create': defaultDraft('calendar.create'),
    'email.draft': defaultDraft('email.draft'),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!accessToken) return;
    try { setOverview(await fetchAutopilot(accessToken)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load Autopilot.'); }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined);
    try { await work(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Autopilot request failed.'); }
    finally { setBusy(false); }
  };

  const patchDraft = (actionClass: AutopilotActionClass, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [actionClass]: { ...current[actionClass], ...patch } }));

  if (!overview) {
    return (
      <Screen eyebrow="Autopilot" title="Standing authority, inside your rules." subtitle="Loading your rules…">
        {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      </Screen>
    );
  }

  const { autopilot } = overview;
  if (!autopilot.entitled) {
    return (
      <Screen eyebrow="Autopilot" title="Standing authority, inside your rules." subtitle="Autopilot lets APM handle approved recurring work without asking each time—only inside rules you write and can revoke.">
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
    <Screen eyebrow="Autopilot" title="Standing authority, inside your rules." subtitle="APM acts without asking each time only where you have written a rule. Everything is reversible, audited and revocable.">
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

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
              <KeyValue label="Undo" value={policy.undo === 'delete_event' ? 'Removes the event APM created' : 'Deletes the draft APM prepared'} />
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
                <View style={styles.choiceGrid}>
                  {WEEKDAYS.map((day) => {
                    const on = draft.weekdays.includes(day.id);
                    return (
                      <Pressable key={day.id} onPress={() => patchDraft(policy.actionClass, { weekdays: on ? draft.weekdays.filter((d) => d !== day.id) : [...draft.weekdays, day.id] })} style={[styles.choice, on && styles.choiceActive]}>
                        <Text style={[styles.choiceText, on && styles.choiceTextActive]}>{day.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextInput value={draft.windowStart} onChangeText={(v) => patchDraft(policy.actionClass, { windowStart: v })} placeholder="Window start · HH:MM" placeholderTextColor={colors.inkMuted} style={styles.input} />
                <TextInput value={draft.windowEnd} onChangeText={(v) => patchDraft(policy.actionClass, { windowEnd: v })} placeholder="Window end · HH:MM" placeholderTextColor={colors.inkMuted} style={styles.input} />
                <TextInput value={draft.maxPerDay} onChangeText={(v) => patchDraft(policy.actionClass, { maxPerDay: v })} placeholder="Most per day" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
                {policy.actionClass === 'calendar.create' ? (
                  <>
                    <TextInput value={draft.maxDurationMinutes} onChangeText={(v) => patchDraft(policy.actionClass, { maxDurationMinutes: v })} placeholder="Longest block · minutes" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
                    <TextInput value={draft.horizonDays} onChangeText={(v) => patchDraft(policy.actionClass, { horizonDays: v })} placeholder="How far ahead · days" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
                    <Body muted>APM will never place a block over busy, tentative or out-of-office time.</Body>
                  </>
                ) : (
                  <>
                    <TextInput value={draft.domains} onChangeText={(v) => patchDraft(policy.actionClass, { domains: v })} autoCapitalize="none" placeholder="Allowed recipient domains · comma separated" placeholderTextColor={colors.inkMuted} style={styles.input} />
                    <Body muted>Drafts only. Autopilot never sends email.</Body>
                  </>
                )}
                <TextInput value={draft.expiresInDays} onChangeText={(v) => patchDraft(policy.actionClass, { expiresInDays: v })} placeholder="Rule lasts · days (max 90)" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
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

      <SectionTitle>Recent Autopilot runs</SectionTitle>
      {autopilot.executions.length ? autopilot.executions.slice(0, 20).map((run) => (
        <Card key={run.id}>
          <View style={uiStyles.row}>
            <CardTitle>{run.actionClass === 'calendar.create' ? 'Calendar block' : 'Email draft'}</CardTitle>
            <Pill tone={run.status === 'failed' ? 'warning' : undefined}>{run.status}</Pill>
          </View>
          {run.proposedStartsAt ? <KeyValue label="When" value={new Date(run.proposedStartsAt).toLocaleString()} /> : null}
          <KeyValue label="Ran" value={new Date(run.claimedAt).toLocaleString()} />
          {run.failureCode ? <KeyValue label="Failure" value={run.failureCode} /> : null}
          {run.status === 'verified' ? <Button label="Undo" variant="secondary" onPress={() => void act(() => undoAutopilotExecution(run.id, accessToken!))} /> : null}
        </Card>
      )) : <Card><Body muted>No Autopilot runs yet. Every run is recorded in Activity.</Body></Card>}

      <SectionTitle>Never on Autopilot</SectionTitle>
      <Card>
        {overview.neverStanding.map((item) => <ListItem key={item.match} title={item.match} detail={item.reason} />)}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.ink,
    fontSize: 16,
  },
  choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  choiceActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceText: { color: colors.ink, fontSize: 14 },
  choiceTextActive: { color: colors.surface },
});
