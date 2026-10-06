import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LifeAdminItem, LifeAdminKind, LifeRelationship } from '@apm/domain';
import { Body, Button, Card, CardTitle, KeyValue, Pill, Screen, SectionTitle, uiStyles } from '../../src/components/ui';
import { colors, radius, spacing } from '../../src/theme';
import { useLifeGraph } from '../../src/state/lifeGraph';

const kinds: Array<{ id: LifeAdminKind; label: string }> = [
  { id: 'appointment', label: 'Appointment' },
  { id: 'trip', label: 'Travel' },
  { id: 'bill', label: 'Bill' },
  { id: 'subscription', label: 'Subscription' },
  { id: 'meal_plan', label: 'Meal plan' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'health_routine', label: 'Health routine' },
  { id: 'recurring_obligation', label: 'Recurring obligation' },
  { id: 'family_obligation', label: 'Family obligation' },
];

const recurringKinds = new Set<LifeAdminKind>(['bill','subscription','health_routine','recurring_obligation','family_obligation']);
function parseDateOnly(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return undefined;
  return { year, month, day };
}

function zonedParts(value: Date, timezone?: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
      second: read('second'),
    };
  } catch {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
    };
  }
}

function localDateTimeToIso(
  dateOnly: string,
  time: { hour: number; minute: number; second: number },
  timezone?: string,
): string {
  const date = parseDateOnly(dateOnly);
  if (!date) throw new Error('Enter a real calendar date in YYYY-MM-DD format.');
  const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second);
  let candidate = desiredAsUtc;

  for (let pass = 0; pass < 3; pass += 1) {
    const observed = zonedParts(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    candidate -= observedAsUtc - desiredAsUtc;
  }

  return new Date(candidate).toISOString();
}

function dateToIso(value: string, timezone?: string): string | undefined {
  if (!value.trim()) return undefined;
  return localDateTimeToIso(value.trim(), { hour: 12, minute: 0, second: 0 }, timezone);
}

function formatDate(value?: string, timezone?: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = zonedParts(parsed, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function shiftTimedRangeToDate(
  startsAt: string,
  endsAt: string | undefined,
  targetDate: string,
  timezone?: string,
): { startsAt: string; endsAt?: string } {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new Error('The saved start time is invalid.');
  const localStart = zonedParts(start, timezone);
  const shiftedStart = localDateTimeToIso(
    targetDate,
    { hour: localStart.hour, minute: localStart.minute, second: localStart.second },
    timezone,
  );

  if (!endsAt) return { startsAt: shiftedStart };
  const end = new Date(endsAt);
  const duration = end.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration < 0) return { startsAt: shiftedStart };
  return { startsAt: shiftedStart, endsAt: new Date(new Date(shiftedStart).getTime() + duration).toISOString() };
}

export default function LifeOsScreen() {
  const {
    graph,
    syncStatus,
    createRelationship,
    updateRelationship,
    createLifeItem,
    updateLifeItem,
    completeLifeItem,
  } = useLifeGraph();

  const entitlement = graph.entitlement;
  const hasAccess = Boolean(
    entitlement
    && ['active','trialing'].includes(entitlement.status)
    && (entitlement.plan === 'life_os' || entitlement.plan === 'autopilot'),
  );
  const timezone = graph.identity.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [editingRelationshipId, setEditingRelationshipId] = useState<string>();
  const [personName, setPersonName] = useState('');
  const [relationshipLabel, setRelationshipLabel] = useState('');
  const [birthday, setBirthday] = useState('');
  const [nextContact, setNextContact] = useState('');
  const [cadence, setCadence] = useState('');

  const [editingItemId, setEditingItemId] = useState<string>();
  const [kind, setKind] = useState<LifeAdminKind>('appointment');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [frequency, setFrequency] = useState<'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'>('none');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const peopleById = useMemo(() => new Map(graph.people.map((person) => [person.id, person])), [graph.people]);
  const activeItems = graph.lifeAdminItems.filter((item) => !['completed','cancelled'].includes(item.status));
  const editingItem = editingItemId ? graph.lifeAdminItems.find((item) => item.id === editingItemId) : undefined;

  const resetRelationshipForm = () => {
    setEditingRelationshipId(undefined);
    setPersonName('');
    setRelationshipLabel('');
    setBirthday('');
    setNextContact('');
    setCadence('');
  };

  const resetItemForm = () => {
    setEditingItemId(undefined);
    setKind('appointment');
    setTitle('');
    setDueDate('');
    setFrequency('none');
    setAmount('');
    setCurrency('');
  };

  const beginRelationshipEdit = (relationship: LifeRelationship) => {
    const person = peopleById.get(relationship.personId);
    setEditingRelationshipId(relationship.id);
    setPersonName(person?.name ?? '');
    setRelationshipLabel(person?.relationship ?? '');
    setBirthday(relationship.birthday ?? '');
    setNextContact(formatDate(relationship.nextContactAt, timezone));
    setCadence(relationship.cadenceDays ? String(relationship.cadenceDays) : '');
    setError(undefined);
  };

  const beginItemEdit = (item: LifeAdminItem) => {
    setEditingItemId(item.id);
    setKind(item.kind);
    setTitle(item.title);
    setDueDate(formatDate(item.startsAt ?? item.dueAt, timezone));
    setFrequency(item.recurrence.frequency ?? 'none');
    setAmount(item.amountMinor !== undefined ? (item.amountMinor / 100).toFixed(2) : '');
    setCurrency(item.currency ?? '');
    setError(undefined);
  };

  const saveRelationship = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (!personName.trim()) throw new Error('Add the person’s name.');
      if (birthday.trim() && !parseDateOnly(birthday.trim())) throw new Error('Birthday must be a real calendar date.');
      const cadenceDays = cadence.trim() ? Number(cadence.trim()) : undefined;
      if (cadenceDays !== undefined && (!Number.isInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > 3650)) {
        throw new Error('Contact cadence must be a whole number of days.');
      }

      if (editingRelationshipId) {
        await updateRelationship(editingRelationshipId, {
          personName: personName.trim(),
          relationship: relationshipLabel.trim(),
          birthday: birthday.trim(),
          nextContactAt: nextContact.trim() ? dateToIso(nextContact, timezone) : '',
          cadenceDays: cadenceDays ?? null,
        });
      } else {
        await createRelationship({
          personName: personName.trim(),
          relationship: relationshipLabel.trim() || undefined,
          birthday: birthday.trim() || undefined,
          nextContactAt: dateToIso(nextContact, timezone),
          cadenceDays,
        });
      }
      resetRelationshipForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save relationship.');
    } finally {
      setBusy(false);
    }
  };

  const saveItem = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (!title.trim()) throw new Error('Add a title.');
      if (dueDate.trim() && !parseDateOnly(dueDate.trim())) throw new Error('Next date must be a real calendar date.');
      const amountMinor = amount.trim() ? Math.round(Number(amount.trim()) * 100) : undefined;
      if (amountMinor !== undefined && (!Number.isFinite(amountMinor) || amountMinor < 0)) throw new Error('Enter a valid amount.');
      const normalizedCurrency = currency.trim().toUpperCase();
      if (amountMinor !== undefined && !/^[A-Z]{3}$/.test(normalizedCurrency)) throw new Error('Add a 3-letter currency code for the amount.');
      const recurrence = frequency === 'none' ? {} : { frequency, interval: 1 } as const;

      if (editingItemId && editingItem) {
        const schedule: { dueAt?: string; startsAt?: string; endsAt?: string } = {};
        if (editingItem.startsAt) {
          if (dueDate.trim()) {
            const shifted = shiftTimedRangeToDate(editingItem.startsAt, editingItem.endsAt, dueDate.trim(), timezone);
            schedule.startsAt = shifted.startsAt;
            if (editingItem.endsAt) schedule.endsAt = shifted.endsAt ?? '';
            if (editingItem.dueAt) schedule.dueAt = dateToIso(dueDate, timezone);
          } else {
            schedule.startsAt = '';
            if (editingItem.endsAt) schedule.endsAt = '';
            if (editingItem.dueAt) schedule.dueAt = '';
          }
        } else {
          schedule.dueAt = dueDate.trim() ? dateToIso(dueDate, timezone) : '';
        }

        await updateLifeItem(editingItemId, {
          kind,
          title: title.trim(),
          recurrence,
          amountMinor: amountMinor ?? null,
          currency: amountMinor !== undefined ? normalizedCurrency : '',
          ...schedule,
        });
      } else {
        await createLifeItem({
          kind,
          title: title.trim(),
          dueAt: dateToIso(dueDate, timezone),
          recurrence,
          amountMinor,
          currency: amountMinor !== undefined ? normalizedCurrency : undefined,
        });
      }
      resetItemForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save Life OS item.');
    } finally {
      setBusy(false);
    }
  };

  const finishItem = async (itemId: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await completeLifeItem(itemId);
      if (editingItemId === itemId) resetItemForm();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete item.'); }
    finally { setBusy(false); }
  };

  const cancelItem = async (itemId: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await updateLifeItem(itemId, { status: 'cancelled' });
      if (editingItemId === itemId) resetItemForm();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to cancel item.'); }
    finally { setBusy(false); }
  };

  const contacted = async (relationshipId: string, cadenceDays?: number) => {
    if (!cadenceDays || busy) return;
    setBusy(true); setError(undefined);
    try {
      const next = new Date();
      next.setUTCDate(next.getUTCDate() + cadenceDays);
      await updateRelationship(relationshipId, { nextContactAt: next.toISOString() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to move the relationship cadence.');
    } finally {
      setBusy(false);
    }
  };

  if (!hasAccess) {
    return (
      <Screen eyebrow="Life OS" title="Carry more of the mental load." subtitle="Life OS manages the recurring personal obligations that should not have to live in your head.">
        <Card tone="warning">
          <CardTitle>Life OS is not active on this account.</CardTitle>
          <Body muted>Your current plan can still use the core APM system. Life OS domains require an active Life OS or Autopilot entitlement, enforced by the server and database.</Body>
          <Button label="View plans" onPress={() => router.push('/settings/plan')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen eyebrow="Life OS" title="The stuff your brain should not have to carry." subtitle="Relationships, appointments, travel, bills, subscriptions, meals, shopping, health routines and recurring obligations feed the same Today + Radar system.">
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      {syncStatus === 'saving' ? <Pill tone="warning">Saving…</Pill> : null}

      <SectionTitle>Relationships</SectionTitle>
      <Card tone="accent">
        <CardTitle>{editingRelationshipId ? 'Correct relationship' : 'Protect a relationship'}</CardTitle>
        <Body muted>{editingRelationshipId ? 'Update the canonical state that drives Radar.' : 'Birthdays and contact cadence become proactive Radar signals. This is individual Life OS state—not Household sharing.'}</Body>
        <TextInput value={personName} onChangeText={setPersonName} placeholder="Person’s name" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={relationshipLabel} onChangeText={setRelationshipLabel} placeholder="Relationship (friend, parent, mentor…)" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={birthday} onChangeText={setBirthday} placeholder="Birthday · YYYY-MM-DD" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={nextContact} onChangeText={setNextContact} placeholder="Next contact · YYYY-MM-DD" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={cadence} onChangeText={setCadence} placeholder="Cadence in days · optional" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <Button label={busy ? 'Saving…' : editingRelationshipId ? 'Save corrections' : 'Save relationship'} onPress={() => void saveRelationship()} />
        {editingRelationshipId ? <Button label="Cancel edit" variant="secondary" onPress={resetRelationshipForm} /> : null}
      </Card>

      {graph.lifeRelationships.length ? (
        <View style={uiStyles.stack}>
          {graph.lifeRelationships.map((relationship) => {
            const person = peopleById.get(relationship.personId);
            return (
              <Card key={relationship.id}>
                <View style={uiStyles.row}>
                  <CardTitle>{person?.name ?? 'Relationship'}</CardTitle>
                  <Pill>{person?.relationship ?? 'relationship'}</Pill>
                </View>
                <KeyValue label="Birthday" value={relationship.birthday ?? 'Not set'} />
                <KeyValue label="Next contact" value={formatDate(relationship.nextContactAt, timezone) || 'Not set'} />
                <KeyValue label="Cadence" value={relationship.cadenceDays ? `Every ${relationship.cadenceDays} days` : 'Not set'} />
                <Button label="Edit" variant="secondary" onPress={() => beginRelationshipEdit(relationship)} />
                {relationship.cadenceDays ? <Button label="Contacted · move cadence forward" variant="secondary" onPress={() => void contacted(relationship.id, relationship.cadenceDays)} /> : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      <SectionTitle>Life administration</SectionTitle>
      <Card>
        <CardTitle>{editingItemId ? 'Correct Life OS item' : 'Add something APM should carry'}</CardTitle>
        {editingItemId ? <Body muted>Corrections update the canonical record that drives Today and Radar.</Body> : null}
        <View style={styles.choiceGrid}>
          {kinds.map((item) => (
            <Pressable key={item.id} onPress={() => { setKind(item.id); if (!recurringKinds.has(item.id)) setFrequency('none'); }} style={[styles.choice, kind === item.id && styles.choiceActive]}>
              <Text style={[styles.choiceText, kind === item.id && styles.choiceTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput value={title} onChangeText={setTitle} placeholder="What needs to be handled?" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={dueDate} onChangeText={setDueDate} placeholder="Next date / due date · YYYY-MM-DD" placeholderTextColor={colors.inkMuted} style={styles.input} />
        {kind === 'bill' || kind === 'subscription' ? (
          <View style={uiStyles.stackSm}>
            <TextInput value={amount} onChangeText={setAmount} placeholder="Amount · optional" keyboardType="decimal-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
            <TextInput value={currency} onChangeText={setCurrency} autoCapitalize="characters" placeholder="Currency · e.g. USD" placeholderTextColor={colors.inkMuted} style={styles.input} />
          </View>
        ) : null}
        {recurringKinds.has(kind) ? (
          <>
            <Body muted>Repeat after completion</Body>
            <View style={styles.choiceGrid}>
              {(['none','daily','weekly','monthly','yearly'] as const).map((item) => (
                <Pressable key={item} onPress={() => setFrequency(item)} style={[styles.choice, frequency === item && styles.choiceActive]}>
                  <Text style={[styles.choiceText, frequency === item && styles.choiceTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <Button label={busy ? 'Saving…' : editingItemId ? 'Save corrections' : 'Add to Life OS'} onPress={() => void saveItem()} />
        {editingItemId ? <Button label="Cancel edit" variant="secondary" onPress={resetItemForm} /> : null}
      </Card>

      <SectionTitle>Open loops</SectionTitle>
      {activeItems.length ? (
        <View style={uiStyles.stack}>
          {activeItems.map((item) => (
            <Card key={item.id} tone={item.importance >= 4 ? 'warning' : 'default'}>
              <View style={uiStyles.row}>
                <Pill>{item.kind.replaceAll('_', ' ')}</Pill>
                <Pill>{item.status}</Pill>
              </View>
              <CardTitle>{item.title}</CardTitle>
              <KeyValue label="Next date" value={formatDate(item.startsAt ?? item.dueAt, timezone) || 'Not set'} />
              <KeyValue label="Repeat" value={item.recurrence.frequency ? `Every ${item.recurrence.interval ?? 1} ${item.recurrence.frequency}` : 'No'} />
              {item.amountMinor !== undefined && item.currency ? <KeyValue label="Amount" value={`${item.currency} ${(item.amountMinor / 100).toFixed(2)}`} /> : null}
              <Button label="Edit" variant="secondary" onPress={() => beginItemEdit(item)} />
              <Button label={item.recurrence.frequency ? 'Done · schedule next occurrence' : 'Mark complete'} onPress={() => void finishItem(item.id)} />
              <Button label="Cancel" variant="secondary" onPress={() => void cancelItem(item.id)} />
            </Card>
          ))}
        </View>
      ) : (
        <Card tone="muted"><Body muted>No open Life OS items yet.</Body></Card>
      )}
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
  choiceText: { color: colors.ink, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  choiceTextActive: { color: '#FFFFFF' },
});
