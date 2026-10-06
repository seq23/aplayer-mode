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
