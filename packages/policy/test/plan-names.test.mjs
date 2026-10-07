// ADR-0006 guard: the paid plans are shown as Executive Roundtable / Executive Suite /
// Autopilot. "Life OS" is never a user-facing word, and "Chief of Staff" names ONLY one
// of the five jobs every plan does, never a plan. Scans every source a user can read
// (the mobile app, the API, the content modules) with comments stripped, plus the docs.
// Internal keys (`chief_of_staff`, `life_os`, `life_os_domains`, store ids) stay legal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Every user-readable source tree: app screens and components, API, content modules. */
const SOURCE_ROOTS = [
  'apps/mobile/app',
  'apps/mobile/src',
  'services/api/src',
  'packages/planning/src',
  'packages/radar/src',
  'packages/policy/src',
  'packages/domain/src',
];

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules' || name.startsWith('.')) return [];
  return statSync(path).isDirectory() ? walk(path) : [path];
});

/** Strip block and line comments (not `://` inside URLs) so only shipped text remains. */
export const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

/** "Chief of Staff" is legal only as the job (the five-jobs list, or a user's system name). */
const JOB_CONTEXT = [
  /title: 'Chief of Staff', body: /,
  /'My Chief of Staff'/,
];

export function planNameOffenders(file, text) {
  const out = [];
  stripComments(text).split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    if (/\b[Ll]ife ?OS\b/.test(line)) out.push(`${where} "Life OS" is not a user-facing word (say "life areas" or the plan's displayName)`);
    const hits = line.match(/Chief[ -]of[ -]Staff/g) ?? []; // Title Case = a name; "a chief of staff" is the generic role
    const legal = JOB_CONTEXT.reduce((n, re) => n + (line.match(new RegExp(re.source, 'g')) ?? []).length, 0);
    if (hits.length > legal) out.push(`${where} "Chief of Staff" used outside the five-jobs list (a plan name?)`);
  });
  return out;
}

const sourceFiles = () => SOURCE_ROOTS
  .flatMap((root) => walk(join(repoRoot, root)))
  .filter((path) => /\.(ts|tsx|js|mjs)$/.test(path));

test('no user-readable source calls a plan "Life OS" or "Chief of Staff"', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 80, `the scan actually reaches the app, API and content (${files.length} files)`);
  for (const must of ['apps/mobile/src/content/sell.ts', 'apps/mobile/app/settings/index.tsx', 'apps/mobile/src/billing/PlanChoice.tsx', 'services/api/src/index.ts', 'packages/planning/src/intake/engine.ts']) {
    assert.ok(files.some((path) => relative(repoRoot, path) === must), `scan covers ${must}`);
  }
  const offenders = files.flatMap((path) => planNameOffenders(relative(repoRoot, path), readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the five jobs still include Chief of Staff (the job is not renamed)', () => {
  const sell = readFileSync(join(repoRoot, 'apps/mobile/src/content/sell.ts'), 'utf8');
  assert.match(sell, /title: 'Chief of Staff', body: /);
});

test('docs name plans only by their new names; "Chief of Staff" appears only as a job', () => {
  const files = ['README.md', 'AGENTS.md'];
  for (const dir of ['docs', 'docs/adr']) for (const f of readdirSync(join(repoRoot, dir))) if (f.endsWith('.md')) files.push(`${dir}/${f}`);
  const offenders = [];
  for (const file of files) {
    if (file === 'docs/adr/ADR-0006-PLAN-DISPLAY-NAMES.md') continue; // records the old names on purpose
    readFileSync(join(repoRoot, file), 'utf8').split('\n').forEach((line, i) => {
      if (/\bLife OS\b/.test(line)) offenders.push(`${file}:${i + 1} Life OS`);
      if (/Chief[ -]of[ -]Staff/.test(line) && !/Executive Assistant · Chief of Staff · Accountability Partner/.test(line)) offenders.push(`${file}:${i + 1} Chief of Staff`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the guard itself catches the retired names (negative controls)', () => {
  const bad = [
    "<CardTitle>Chief of Staff · Life OS · Autopilot</CardTitle>",
    "displayName: 'Chief of Staff Beta',",
    "highlights: ['Everything in Chief of Staff'],",
    "deadlines: ['Deadlines', 'Radar counts down.', 'Chief of Staff'],",
    "<Screen eyebrow=\"Life OS\" title=\"x\">",
    "label: `Life OS · ${kind}`",
    "setError('Unable to save LifeOS item')",
  ];
  for (const line of bad) assert.ok(planNameOffenders('x.tsx', line).length > 0, `guard misses: ${line}`);
  const good = [
    "{ title: 'Chief of Staff', body: 'Keeps projects lined up.' },",
    "systemName: z.enum(['My A Player Mode', 'My Chief of Staff']),",
    "// Life OS rows are written only through RPCs (a comment)",
    "/* Chief of Staff plan, historical note */",
    "const lifeOs = lifeOsBlocks(graph); // a chief of staff for sequencing",
    "const life_os = PLAN_PRICES.life_os.displayName; fetch('https://x.test/v1');",
  ];
  for (const line of good) assert.deepEqual(planNameOffenders('x.tsx', line), [], `guard over-matches: ${line}`);
});
