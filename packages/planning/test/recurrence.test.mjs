import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecurrence, nextRecurringOccurrence, nextRecurringSchedule } from '../.test-dist/recurrence.js';

test('monthly recurrence clamps January 31 to February month-end', () => {
  const result = addRecurrence(new Date('2027-01-31T12:00:00.000Z'), { frequency: 'monthly', interval: 1 });
  assert.equal(result?.toISOString(), '2027-02-28T12:00:00.000Z');
});

test('leap-day yearly recurrence clamps safely in a non-leap year', () => {
  const result = addRecurrence(new Date('2028-02-29T12:00:00.000Z'), { frequency: 'yearly', interval: 1 });
  assert.equal(result?.toISOString(), '2029-02-28T12:00:00.000Z');
});

test('early completion advances at least one recurring occurrence', () => {
  const result = nextRecurringOccurrence(
    new Date('2026-10-31T12:00:00.000Z'),
    new Date('2026-10-20T12:00:00.000Z'),
    { frequency: 'monthly', interval: 1 },
  );
  assert.equal(result?.toISOString(), '2026-11-30T12:00:00.000Z');
});

test('late completion skips missed occurrences instead of creating catch-up debt', () => {
  const result = nextRecurringOccurrence(
    new Date('2026-01-15T12:00:00.000Z'),
    new Date('2026-04-20T12:00:00.000Z'),
    { frequency: 'monthly', interval: 1 },
  );
  assert.equal(result?.toISOString(), '2026-05-15T12:00:00.000Z');
});


test('daily recurrence skips more than 500 missed occurrences and remains active', () => {
  const completed = new Date('2026-10-06T12:00:00.000Z');
  const result = nextRecurringOccurrence(
    new Date('2025-01-01T12:00:00.000Z'),
    completed,
    { frequency: 'daily', interval: 1 },
  );
  assert.ok(result);
  assert.ok(result.getTime() > completed.getTime());
  assert.equal(result?.toISOString(), '2026-10-07T12:00:00.000Z');
});

test('monthly rollover keeps the original month-day anchor after a short month', () => {
  const result = nextRecurringOccurrence(
    new Date('2027-01-31T12:00:00.000Z'),
    new Date('2027-03-01T12:00:00.000Z'),
    { frequency: 'monthly', interval: 1 },
  );
  assert.equal(result?.toISOString(), '2027-03-31T12:00:00.000Z');
});


test('timed recurring items advance start and end while preserving duration', () => {
  const result = nextRecurringSchedule(
    {
      startsAt: new Date('2026-10-06T15:00:00.000Z'),
      endsAt: new Date('2026-10-06T16:30:00.000Z'),
    },
    new Date('2026-10-06T17:00:00.000Z'),
    { frequency: 'weekly', interval: 1 },
  );
  assert.equal(result.startsAt?.toISOString(), '2026-10-13T15:00:00.000Z');
  assert.equal(result.endsAt?.toISOString(), '2026-10-13T16:30:00.000Z');
  assert.equal(result.dueAt, undefined);
});

test('a schedule with both due and timed fields advances both representations', () => {
  const result = nextRecurringSchedule(
    {
      dueAt: new Date('2026-10-06T12:00:00.000Z'),
      startsAt: new Date('2026-10-06T15:00:00.000Z'),
      endsAt: new Date('2026-10-06T16:00:00.000Z'),
    },
    new Date('2026-10-06T18:00:00.000Z'),
    { frequency: 'monthly', interval: 1 },
  );
  assert.equal(result.dueAt?.toISOString(), '2026-11-06T12:00:00.000Z');
  assert.equal(result.startsAt?.toISOString(), '2026-11-06T15:00:00.000Z');
  assert.equal(result.endsAt?.toISOString(), '2026-11-06T16:00:00.000Z');
});


test('undated recurring items use completion as the next-occurrence anchor', () => {
  const completed = new Date('2026-10-06T12:00:00.000Z');
  const result = nextRecurringSchedule(
    {},
    completed,
    { frequency: 'monthly', interval: 1 },
  );
  assert.equal(result.dueAt?.toISOString(), '2026-11-06T12:00:00.000Z');
  assert.equal(result.startsAt, undefined);
});


test('persistent monthly anchor restores the intended day after a clamped month', () => {
  const recurrence = {
    frequency: 'monthly',
    interval: 1,
    anchorDueAt: '2027-01-31T12:00:00.000Z',
  };
  const first = nextRecurringSchedule(
    { dueAt: new Date('2027-01-31T12:00:00.000Z') },
    new Date('2027-01-31T18:00:00.000Z'),
    recurrence,
  );
  assert.equal(first.dueAt?.toISOString(), '2027-02-28T12:00:00.000Z');

  const second = nextRecurringSchedule(
    { dueAt: first.dueAt },
    new Date('2027-02-28T18:00:00.000Z'),
    recurrence,
  );
  assert.equal(second.dueAt?.toISOString(), '2027-03-31T12:00:00.000Z');
});

test('persistent timed anchor restores the intended day while preserving duration', () => {
  const recurrence = {
    frequency: 'monthly',
    interval: 1,
    anchorStartsAt: '2027-01-31T15:00:00.000Z',
  };
  const feb = nextRecurringSchedule(
    {
      startsAt: new Date('2027-01-31T15:00:00.000Z'),
      endsAt: new Date('2027-01-31T16:30:00.000Z'),
    },
    new Date('2027-01-31T18:00:00.000Z'),
    recurrence,
  );
  assert.equal(feb.startsAt?.toISOString(), '2027-02-28T15:00:00.000Z');
  assert.equal(feb.endsAt?.toISOString(), '2027-02-28T16:30:00.000Z');

  const mar = nextRecurringSchedule(
    {
      startsAt: feb.startsAt,
      endsAt: feb.endsAt,
    },
    new Date('2027-02-28T18:00:00.000Z'),
    recurrence,
  );
  assert.equal(mar.startsAt?.toISOString(), '2027-03-31T15:00:00.000Z');
  assert.equal(mar.endsAt?.toISOString(), '2027-03-31T16:30:00.000Z');
});


test('monthly recurrence preserves a UTC+13 local month-end date', () => {
  const timezone = 'Pacific/Auckland';
  const recurrence = {
    frequency: 'monthly',
    interval: 1,
    timezone,
    anchorDueAt: '2027-01-30T23:00:00.000Z',
  };
  const next = nextRecurringSchedule(
    { dueAt: new Date('2027-01-30T23:00:00.000Z') },
    new Date('2027-01-31T02:00:00.000Z'),
    recurrence,
  );
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(next.dueAt);
  const read = (type) => local.find((part) => part.type === type)?.value;
  assert.equal(`${read('year')}-${read('month')}-${read('day')}`, '2027-02-28');
  assert.equal(read('hour'), '12');
});

test('daily recurrence preserves local clock time across DST changes', () => {
  const timezone = 'America/New_York';
  const recurrence = {
    frequency: 'daily',
    interval: 1,
    timezone,
    anchorDueAt: '2026-03-07T14:00:00.000Z',
  };
  const next = nextRecurringSchedule(
    { dueAt: new Date('2026-03-07T14:00:00.000Z') },
    new Date('2026-03-07T15:00:00.000Z'),
    recurrence,
  );
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(next.dueAt);
  assert.equal(local, '09:00');
});
