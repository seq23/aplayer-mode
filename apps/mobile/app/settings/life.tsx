import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LifeAdminKind } from '@apm/domain';
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

function dateToIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) throw new Error('Use YYYY-MM-DD for dates.');
  const result = new Date(`${value.trim()}T12:00:00.000Z`);
  if (Number.isNaN(result.getTime())) throw new Error('Enter a valid date.');
  return result.toISOString();
}

function formatDate(value?: string): string {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
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

  const [personName, setPersonName] = useState('');
  const [relationshipLabel, setRelationshipLabel] = useState('');
  const [birthday, setBirthday] = useState('');
  const [nextContact, setNextContact] = useState('');
  const [cadence, setCadence] = useState('');

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

  const saveRelationship = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (!personName.trim()) throw new Error('Add the person’s name.');
      const cadenceDays = cadence.trim() ? Number(cadence.trim()) : undefined;
      if (cadenceDays !== undefined && (!Number.isInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > 3650)) {
        throw new Error('Contact cadence must be a whole number of days.');
      }
      await createRelationship({
        personName: personName.trim(),
        relationship: relationshipLabel.trim() || undefined,
        birthday: birthday.trim() || undefined,
        nextContactAt: dateToIso(nextContact),
        cadenceDays,
      });
      setPersonName(''); setRelationshipLabel(''); setBirthday(''); setNextContact(''); setCadence('');
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
      const dueAt = dateToIso(dueDate);
      const amountMinor = amount.trim() ? Math.round(Number(amount.trim()) * 100) : undefined;
      if (amountMinor !== undefined && (!Number.isFinite(amountMinor) || amountMinor < 0)) throw new Error('Enter a valid amount.');
      const normalizedCurrency = currency.trim().toUpperCase();
      if (amountMinor !== undefined && !/^[A-Z]{3}$/.test(normalizedCurrency)) throw new Error('Add a 3-letter currency code for the amount.');
      await createLifeItem({
        kind,
        title: title.trim(),
        dueAt,
        recurrence: frequency === 'none' ? {} : { frequency, interval: 1 },
        amountMinor,
        currency: amountMinor !== undefined ? normalizedCurrency : undefined,
      });
      setTitle(''); setDueDate(''); setAmount(''); setCurrency('');
      if (!recurringKinds.has(kind)) setFrequency('none');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save Life OS item.');
    } finally {
      setBusy(false);
    }
  };

  const finishItem = async (itemId: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await completeLifeItem(itemId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete item.'); }
    finally { setBusy(false); }
  };

  const cancelItem = async (itemId: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await updateLifeItem(itemId, { status: 'cancelled' }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to cancel item.'); }
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
        <CardTitle>Protect a relationship</CardTitle>
        <Body muted>Birthdays and contact cadence become proactive Radar signals. This is individual Life OS state—not Household sharing.</Body>
        <TextInput value={personName} onChangeText={setPersonName} placeholder="Person’s name" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={relationshipLabel} onChangeText={setRelationshipLabel} placeholder="Relationship (friend, parent, mentor…)" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={birthday} onChangeText={setBirthday} placeholder="Birthday · YYYY-MM-DD" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={nextContact} onChangeText={setNextContact} placeholder="Next contact · YYYY-MM-DD" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <TextInput value={cadence} onChangeText={setCadence} placeholder="Cadence in days · optional" keyboardType="number-pad" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <Button label={busy ? 'Saving…' : 'Save relationship'} onPress={() => void saveRelationship()} />
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
                <KeyValue label="Next contact" value={formatDate(relationship.nextContactAt)} />
                <KeyValue label="Cadence" value={relationship.cadenceDays ? `Every ${relationship.cadenceDays} days` : 'Not set'} />
                {relationship.cadenceDays ? <Button label="Contacted · move cadence forward" variant="secondary" onPress={() => void contacted(relationship.id, relationship.cadenceDays)} /> : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      <SectionTitle>Life administration</SectionTitle>
      <Card>
        <CardTitle>Add something APM should carry</CardTitle>
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
        <Button label={busy ? 'Saving…' : 'Add to Life OS'} onPress={() => void saveItem()} />
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
              <KeyValue label="Next date" value={formatDate(item.dueAt ?? item.startsAt)} />
              <KeyValue label="Repeat" value={item.recurrence.frequency ? `Every ${item.recurrence.interval ?? 1} ${item.recurrence.frequency}` : 'No'} />
              {item.amountMinor !== undefined && item.currency ? <KeyValue label="Amount" value={`${item.currency} ${(item.amountMinor / 100).toFixed(2)}`} /> : null}
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
