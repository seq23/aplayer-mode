#!/usr/bin/env node
// One self-closing issue per red host, from a weekly outcome report
// (Search Readiness Checklist i9). Red host: the issue is opened, or commented on
// if it is already open. Green host with an open issue: a closing comment, then
// closed. Green host with no issue: nothing.
//
// Needs `gh` authenticated (the workflow passes GITHUB_TOKEN).
//
// Usage:
//   node scripts/weekly-outcome-issues.mjs reports/outcomes/2026-W44.json
//   node scripts/weekly-outcome-issues.mjs <report> --dry-run   print the calls, make none
//   node scripts/weekly-outcome-issues.mjs --self-check          pure checks, no gh, no network
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const TITLE_PREFIX = 'Outcome red: ';

export const titleFor = (host) => `${TITLE_PREFIX}${host}`;

/** The issue body for a red host. Pure, so --self-check can pin it. */
export function redBody(report, site, runUrl) {
  return [
    `**${site.host}** (${site.label}) is red in ${report.week}.`,
    '',
    `The fix lives in \`${site.repo}\`.`,
    '',
    ...site.red.map((reason) => `- ${reason}`),
    '',
    `Measured ${report.generated_at}. Full report: \`reports/outcomes/${report.week}.md\`.`,
    ...(runUrl ? ['', `Run: ${runUrl}`] : []),
    '',
    `This issue closes itself on the first weekly run where ${site.host} answers green again.`,
  ].join('\n');
}

/** What to do with each host this week. Pure. */
export function planFor(report, openIssues) {
  const numberOf = (host) => openIssues.find((i) => i.title === titleFor(host))?.number ?? null;
  return report.sites.map((site) => {
    const number = numberOf(site.host);
    if (site.red?.length) return { host: site.host, action: number ? 'comment' : 'open', number };
    return number ? { host: site.host, action: 'close', number } : { host: site.host, action: 'none', number: null };
  });
}

const gh = (args, dryRun) => {
  if (dryRun) { console.log(`would run: gh ${args.join(' ')}`); return ''; }
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`NAMED STOP [GH_FAILED] gh ${args.slice(0, 3).join(' ')}: ${(r.stderr ?? '').trim().slice(0, 300)}`);
    process.exit(1);
  }
  return (r.stdout ?? '').trim();
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-check')) {
    const problems = [];
    const report = {
      week: '2026-W44', generated_at: '2026-10-26T04:00:00.000Z',
      sites: [
        { host: 'a.example', label: 'A', repo: 'aplayer-mode', red: ['/ answered 500, expected 200'] },
        { host: 'b.example', label: 'B', repo: 'aplayer-mode', red: [] },
        { host: 'c.example', label: 'C', repo: 'other-repo', red: ['/robots.txt answered 404'] },
      ],
    };
    const plan = planFor(report, [{ number: 7, title: titleFor('b.example') }, { number: 9, title: titleFor('c.example') }]);
    const want = [
      { host: 'a.example', action: 'open', number: null },
      { host: 'b.example', action: 'close', number: 7 },
      { host: 'c.example', action: 'comment', number: 9 },
    ];
    if (JSON.stringify(plan) !== JSON.stringify(want)) problems.push(`planFor is wrong: ${JSON.stringify(plan)}`);
    const body = redBody(report, report.sites[2], 'https://example.invalid/run/1');
    for (const needle of ['c.example', 'other-repo', '/robots.txt answered 404', 'closes itself', '2026-W44']) {
      if (!body.includes(needle)) problems.push(`redBody omits ${needle}`);
    }
    if (problems.length) {
      console.error(`weekly-outcome-issues --self-check FAILED — ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log('weekly-outcome-issues --self-check passed: a red host opens or updates, a green host with an open issue closes, a green host without one does nothing.');
    return;
  }

  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.error('weekly-outcome-issues: no report path given.'); process.exit(1); }
  const dryRun = argv.includes('--dry-run');
  const report = JSON.parse(await readFile(path, 'utf8'));
  if (!report.sites?.length) { console.error(`weekly-outcome-issues: ${path} holds no hosts — refusing to pass on nothing.`); process.exit(1); }

  let openIssues = [];
  const listed = gh(['issue', 'list', '--state', 'open', '--limit', '200', '--search', `"${TITLE_PREFIX}" in:title`, '--json', 'number,title'], false);
  try { openIssues = JSON.parse(listed || '[]'); } catch { openIssues = []; }

  const runUrl = process.env.RUN_URL ?? null;
  for (const step of planFor(report, openIssues)) {
    const site = report.sites.find((s) => s.host === step.host);
    if (step.action === 'open') {
      gh(['issue', 'create', '--title', titleFor(step.host), '--body', redBody(report, site, runUrl)], dryRun);
      console.log(`opened an issue for ${step.host}`);
    } else if (step.action === 'comment') {
      gh(['issue', 'comment', String(step.number), '--body', redBody(report, site, runUrl)], dryRun);
      console.log(`updated #${step.number} for ${step.host}`);
    } else if (step.action === 'close') {
      gh(['issue', 'comment', String(step.number), '--body', `${step.host} answers green again in ${report.week}. Closing.${runUrl ? ` Run: ${runUrl}` : ''}`], dryRun);
      gh(['issue', 'close', String(step.number)], dryRun);
      console.log(`closed #${step.number}: ${step.host} is green again`);
    } else {
      console.log(`${step.host}: green, no open issue`);
    }
  }
}

await main();
