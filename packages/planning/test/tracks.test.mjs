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

// docs/32 is the Track specification; it is pinned to the code here so the doc
// and the one shared display-name map can never drift apart.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const TRACK_DOC = readFileSync(join(repoRoot, 'docs/32-TRACK-LIBRARY-AND-APP-TRACKS.md'), 'utf8');
const section = (heading) => {
  const start = TRACK_DOC.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `docs/32 has section "${heading}"`);
  const next = TRACK_DOC.indexOf('\n## ', start + 3);
  return TRACK_DOC.slice(start, next < 0 ? undefined : next);
};

test('docs/32 Track table is exactly BUILTIN_TRACKS: keys, display names, origin, order', () => {
  const rows = [...section('1. The seven Tracks').matchAll(/^\| `([a-z_]+)` \| ([^|]+?) \| (bhpc|app) \|$/gm)]
    .map(([, key, name, origin]) => ({ key, name, origin }));
  assert.equal(rows.length, 7, 'seven Track rows');
  assert.deepEqual(rows, BUILTIN_TRACKS.map(({ key, name, origin }) => ({ key, name, origin })));
  assert.ok(!/Billionaire Mindset|Manifestation Mastery Track|Investor \+ AI Leverage Track/.test(section('1. The seven Tracks')), 'no retired or superseded names in the Track table');
  assert.ok(!TRACK_DOC.includes('Billionaire Mindset'), 'Track 1 is only ever called by its final display name');
});

test('docs/32 persona table: the five marketed personas, each Track named is one the code recommends', () => {
  const byName = Object.fromEntries(Object.entries(NAMES).map(([key, name]) => [name, key]));
  const fixtures = {
    'Wealth building': { roles: [], goal: 'Build a 3-month emergency fund and pay off my credit card' },
    'Weight loss': { roles: [], goal: 'lose 30 lbs' },
    'Founder / Entrepreneur': { roles: ['Building a business'], goal: 'Get my first 10 paying customers' },
    Operator: { roles: ['Career / leadership'], goal: 'Get promoted to director' },
    'Parent+': { roles: ['Parenting / caregiving', 'Building a business'], goal: 'Launch my business' },
  };
  const rows = [...section('2. Personas we market to').matchAll(/^\| \*\*([^*]+)\*\*[^|]* \| ([^|]+) \|$/gm)];
  assert.deepEqual(rows.map((r) => r[1]), Object.keys(fixtures), 'exactly the five personas, in order');
  for (const [, persona, tracks] of rows) {
    const keys = tracks.split(',').map((t) => byName[t.trim()]);
    assert.ok(keys.length > 0 && keys.every(Boolean), `${persona}: every Track is a display name from the shared map`);
    const recommended = recommendTrackKeys(fixtures[persona].roles, [], fixtures[persona].goal);
    for (const key of keys) assert.ok(recommended.includes(key), `${persona}: code recommends ${key}`);
  }
});

test('docs/32 reason codes all exist in source, and Track 1 principles never imply endorsement', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) sources.push(readFileSync(path, 'utf8'));
    }
  };
  for (const dir of ['packages/planning/src', 'packages/radar/src', 'packages/domain/src', 'services/api/src']) walk(join(repoRoot, dir));
  const code = sources.join('\n');
  const codes = new Set(TRACK_DOC.match(/\b(?:body|wealth|home)\.[a-z_]+\b/g) ?? []);
  assert.ok(codes.size >= 12, `docs/32 names the Track reason codes (found ${codes.size})`);
  for (const reason of codes) assert.ok(code.includes(`'${reason}'`), `reason code ${reason} exists in source`);
  const library = section('1. The seven Tracks');
  assert.match(library, /principle library of high-performer wisdom/);
  assert.match(library, /\*\*principles only\*\*/);
  assert.match(library, /no implied endorsement by real people/);
});
