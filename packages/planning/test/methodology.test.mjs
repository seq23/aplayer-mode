import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptivePrimaryGoalPrompt,
  arbitrateForeground,
  recommendTrackKeys,
} from '../.test-dist/methodology.js';

test('adapts the primary goal question for athletes', () => {
  assert.equal(
    adaptivePrimaryGoalPrompt(['Training / competing']),
    'What are you training for, and by when?',
  );
});

test('adapts the primary goal question for parents without founder language', () => {
  assert.match(
    adaptivePrimaryGoalPrompt(['Parenting / caregiving']),
    /family life/i,
  );
});

test('does not recommend Billionaire Mindset to every user', () => {
  assert.deepEqual(recommendTrackKeys(['Studying / learning']), ['operator_discipline']);
  assert.ok(recommendTrackKeys(['Building a business']).includes('billionaire_mindset'));
});

test('arbitration ranks leverage, urgency, energy match, compounding and downside', () => {
  const result = arbitrateForeground([
    { id: 'a', leverage: 3, urgency: 3, energyMatch: 8, compounding: 3, downside: 3 },
    { id: 'b', leverage: 9, urgency: 8, energyMatch: 7, compounding: 9, downside: 8 },
  ]);
  assert.equal(result.winnerId, 'b');
  assert.equal(result.ranked.length, 2);
});
