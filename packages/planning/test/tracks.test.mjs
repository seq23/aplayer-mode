import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TRACKS, recommendTrackKeys } from '../.test-dist/index.js';

const SEVEN = ['billionaire_mindset', 'operator_discipline', 'strategic_patience', 'resilience', 'body_foundation', 'wealth_foundation', 'home_front'];
const NAMES = {
  billionaire_mindset: 'Billionaire High Performance Coach Track',
  operator_discipline: 'Operator Discipline Track',
  strategic_patience: 'Strategic Patience Track',
  resilience: 'Resilience Track',
  body_foundation: 'Body Foundation Track',
  wealth_foundation: 'Wealth Foundation Track',
  home_front: 'Home Front Track',
};

test('BUILTIN_TRACKS is exactly the seven Tracks: four BHPC + three app-only, retired keys gone', () => {
  assert.deepEqual(BUILTIN_TRACKS.map((t) => t.key), SEVEN);
  assert.deepEqual(BUILTIN_TRACKS.filter((t) => t.origin === 'bhpc').map((t) => t.key), SEVEN.slice(0, 4));
  assert.deepEqual(BUILTIN_TRACKS.filter((t) => t.origin === 'app').map((t) => t.key), SEVEN.slice(4));
  for (const retired of ['manifestation_mastery', 'investor_ai_leverage']) assert.ok(!BUILTIN_TRACKS.some((t) => t.key === retired));
});

test('display names come from the one shared map (owner-approved names)', () => {
  for (const track of BUILTIN_TRACKS) assert.equal(track.name, NAMES[track.key], track.key);
});

test('persona → Track defaults follow the research map and only ever name the seven', () => {
  const cases = [
    { roles: ['Studying / learning'], goal: '', want: ['operator_discipline'], not: ['billionaire_mindset'] },
    { roles: [], goal: 'lose 30 lbs', want: ['body_foundation', 'strategic_patience', 'resilience'], not: ['billionaire_mindset', 'wealth_foundation'] },
    { roles: [], goal: 'Build a 3-month emergency fund and pay off my credit card', want: ['wealth_foundation', 'strategic_patience'], not: ['billionaire_mindset'] },
    { roles: ['Building a business'], goal: 'Save 6 months of runway', want: ['wealth_foundation', 'billionaire_mindset'], not: [] },
    { roles: ['Building a business'], goal: 'Get my first 10 paying customers', want: ['billionaire_mindset', 'operator_discipline', 'strategic_patience', 'resilience'], not: ['home_front'] },
    { roles: ['Career / leadership'], goal: 'Get promoted to director', want: ['operator_discipline', 'strategic_patience', 'resilience'], not: ['billionaire_mindset'] },
    { roles: ['Parenting / caregiving', 'Building a business'], goal: 'Launch my business', want: ['home_front', 'resilience'], not: [] },
    { roles: ['Parenting / caregiving'], goal: 'Get the kids to school on time', want: ['operator_discipline'], not: ['home_front'] },
  ];
  for (const c of cases) {
    const keys = recommendTrackKeys(c.roles, [], c.goal);
    for (const key of c.want) assert.ok(keys.includes(key), `${c.goal || c.roles}: ${key}`);
    for (const key of c.not) assert.ok(!keys.includes(key), `${c.goal || c.roles}: not ${key}`);
    assert.ok(keys.every((key) => SEVEN.includes(key)));
    assert.equal(new Set(keys).size, keys.length);
  }
  assert.ok(recommendTrackKeys([], ['all-or-nothing burnout']).includes('resilience'));
});
