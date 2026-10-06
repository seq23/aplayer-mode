import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecurrence, nextRecurringOccurrence } from '../.test-dist/recurrence.js';

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
