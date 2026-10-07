import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRadarItems } from '../.test-dist/index.js';

const USER = 'u1';
const NOW = new Date('2026-10-07T15:00:00.000Z');
const prov = { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00Z' };
const track = (key) => ({ id: key, userId: USER, key, name: key, active: true, foreground: false, provenance: prov });
const admin = (overrides) => ({ id: 'la', userId: USER, kind: 'bill', title: 'x', status: 'scheduled', importance: 3, recurrence: {}, details: {}, provenance: prov, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...overrides });
function graph(extra = {}) {
  return {
    identity: { userId: USER, displayName: 'Ana', timezone: 'America/Chicago' }, roles: [], pillarSettings: [], tracks: [], modes: [],
    personalOS: { trackSettings: {} }, goals: [], milestones: [], projects: [], commitments: [], nextActions: [], routines: [], people: [],
    lifeRelationships: [], lifeAdminItems: [], preferences: [], rules: [], radarItems: [], evidence: [], connections: [], calendarEvents: [],
    messageSignals: [], permissions: [], actions: [], dayRecords: [], goalPlans: [], planCompletions: [], diaryEntries: [], weeklyReviews: [], osChanges: [],
    ...extra,
  };
}
const codes = (g) => buildRadarItems(g, { now: NOW, maxItems: 20 }).flatMap((item) => item.reasonCodes);

test('no active Track, no Track items', () => {
  assert.deepEqual(codes(graph()).filter((code) => /^(wealth|home|body|resilience|operator)\./.test(code)), []);
});

test('Wealth Foundation: automation presence, 7-day leak review and the debt-order lock', () => {
  const base = { tracks: [track('wealth_foundation')], personalOS: { trackSettings: { debtOrder: ['Visa'] } } };
  assert.ok(codes(graph(base)).includes('wealth.no_automation'));
  const automated = graph({ ...base, lifeAdminItems: [admin({ id: 'a1', kind: 'recurring_obligation', title: 'Automatic savings transfer', recurrence: { frequency: 'monthly' } })] });
  assert.ok(!codes(automated).includes('wealth.no_automation'));
  const sub = graph({ ...base, lifeAdminItems: [admin({ id: 's1', kind: 'subscription', title: 'StreamCo', createdAt: '2026-10-05T00:00:00Z' })] });
  assert.ok(codes(sub).includes('wealth.leak_review'));
  const wrongDebt = graph({ ...base, lifeAdminItems: [admin({ id: 'b1', kind: 'bill', title: 'Extra car loan payment', details: { debtAccount: 'Car loan', extraPayment: true } })] });
  assert.ok(codes(wrongDebt).includes('wealth.debt_order'));
});

test('Home Front: a work/family clash inside 48 h surfaces as "choose now"; after-hours work is counted', () => {
  const g = graph({
    tracks: [track('home_front')], personalOS: { trackSettings: { hardStop: '18:00' } },
    lifeAdminItems: [admin({ id: 'f1', kind: 'family_obligation', title: 'School pickup', startsAt: '2026-10-08T20:30:00Z', endsAt: '2026-10-08T21:30:00Z' })],
    calendarEvents: [
      { id: 'e1', userId: USER, provider: 'google', externalEventId: 'e1', title: 'Board prep', startsAt: '2026-10-08T21:00:00Z', endsAt: '2026-10-08T22:00:00Z', allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false },
      { id: 'e2', userId: USER, provider: 'google', externalEventId: 'e2', title: 'Late call', startsAt: '2026-10-09T01:00:00Z', endsAt: '2026-10-09T01:30:00Z', allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false },
    ],
  });
  const items = buildRadarItems(g, { now: NOW, maxItems: 20 });
  const clash = items.find((item) => item.reasonCodes.includes('home.conflict_ahead'));
  assert.match(clash.headline, /choose now/);
  assert.equal(clash.severity, 'high');
  assert.ok(items.some((item) => item.reasonCodes.includes('home.after_hours')));
});

test('Body Foundation blocks compensation after a logged slip; Resilience and Operator Discipline read the record', () => {
  const g = graph({
    tracks: [track('body_foundation'), track('resilience'), track('operator_discipline')],
    diaryEntries: [{ id: 'd1', userId: USER, kind: 'slip', body: 'Ate the whole pizza', localDay: '2026-10-07', createdAt: '2026-10-07T03:00:00Z' }],
    nextActions: [{ id: 'n1', userId: USER, title: 'Skip lunch to make up for it', status: 'open' }],
    dayRecords: [
      { id: 'r1', userId: USER, day: '2026-10-06', mode: 'standard', verdict: 'mvd', completedActionIds: [], replans: [{ reason: 'external_change', at: 'x' }, { reason: 'safety', at: 'y' }] },
      { id: 'r2', userId: USER, day: '2026-10-05', mode: 'standard', verdict: 'miss', completedActionIds: [], replans: [] },
    ],
  });
  const all = codes(g);
  for (const code of ['body.compensation_blocked', 'resilience.capacity', 'operator.renegotiation']) assert.ok(all.includes(code), code);
  const paused = codes(graph({ ...g, personalOS: { trackSettings: {}, bodyReferral: { since: 'x' } } }));
  assert.ok(!paused.includes('body.compensation_blocked'), 'body coaching is paused under referral');
});

test('a planned goal is never reported as having no next move', () => {
  const goal = { id: 'g1', userId: USER, title: 'lose 30 lbs', status: 'active', health: 'unknown', priority: 1, provenance: prov };
  assert.ok(codes(graph({ goals: [goal] })).includes('goal.no_open_next_action'));
  assert.ok(!codes(graph({ goals: [goal], goalPlans: [{ id: 'p1', goalId: 'g1', status: 'active' }] })).includes('goal.no_open_next_action'));
});
