#!/usr/bin/env node
// Weekly outcome report (Search Readiness Checklist i9). Measures every host in
// config/outcome-sites.json, compares each measure with the newest earlier report in
// reports/outcomes/, and writes reports/outcomes/<ISO-week>.{json,md}.
//
// What "red" means, so the workflow can act on it without reading prose:
//   the front door did not answer its expected status, a declared artifact
//   (robots.txt / sitemap.xml / llms.txt) did not answer 200, the page carries no
//   <title>, or it took longer than 3 s. Every red host carries the repository that
//   can fix it, so the issue the workflow opens names where the fix lives.
//
// Rule 0: this never exits 0 having done nothing. No hosts configured, or every host
// unmeasurable, is exit 1 — not a green report over an empty table.
//
// Usage:
//   node scripts/weekly-outcome-report.mjs               measure, write the report
//   node scripts/weekly-outcome-report.mjs --self-check   pure checks only, no network
//   node scripts/weekly-outcome-report.mjs --dry-run      measure, print, write nothing
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPORT_DIR = join(root, 'reports/outcomes');
const SLOW_MS = 3000;
const UA = 'Mozilla/5.0 (compatible; APMOutcomeReport/1.0; +https://aplayermode.com)';

/** ISO-8601 week key, e.g. 2026-W44. Thursday of the same week decides the year. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The reasons a measured host is red, in the order a reader wants them. Pure. */
export function rednessOf(site, measure) {
  const reasons = [];
  if (measure.error) reasons.push(`did not answer: ${measure.error}`);
  else {
    if (measure.status !== site.expect_status) reasons.push(`${site.path} answered ${measure.status}, expected ${site.expect_status}`);
    if (measure.html && !measure.title) reasons.push('page carries no <title>');
    if (typeof measure.ms === 'number' && measure.ms > SLOW_MS) reasons.push(`took ${(measure.ms / 1000).toFixed(1)} s (over ${SLOW_MS / 1000} s)`);
    for (const [path, status] of Object.entries(measure.artifacts ?? {})) {
      if (status !== 200) reasons.push(`${path} answered ${status}`);
    }
  }
  return reasons;
}

/** Week-over-week deltas for the numbers worth watching. Pure. */
export function deltasOf(now, before) {
  if (!before) return null;
  const out = {};
  for (const key of ['status', 'ms', 'bytes', 'sitemap_urls', 'llms_words']) {
    const a = now[key], b = before[key];
    if (typeof a === 'number' && typeof b === 'number' && a !== b) out[key] = { from: b, to: a, delta: a - b };
  }
  return Object.keys(out).length ? out : null;
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function fetchOnce(url) {
  const started = Date.now();
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  const body = await response.text();
  return { status: response.status, ms: Date.now() - started, url: response.url, body, type: response.headers.get('content-type') ?? '' };
}

async function measure(site) {
  const base = `https://${site.host}`;
  try {
    const page = await fetchOnce(base + site.path);
    const html = /html/i.test(page.type);
    const out = {
      host: site.host, repo: site.repo, label: site.label, path: site.path,
      status: page.status, ms: page.ms, bytes: Buffer.byteLength(page.body), final_url: page.url,
      html, title: html ? titleOf(page.body) : null, artifacts: {},
    };
    for (const path of site.artifacts ?? []) {
      try {
        const artifact = await fetchOnce(base + path);
        out.artifacts[path] = artifact.status;
        if (path.endsWith('sitemap.xml') && artifact.status === 200) out.sitemap_urls = (artifact.body.match(/<loc>/g) ?? []).length;
        if (path.endsWith('llms.txt') && artifact.status === 200) out.llms_words = artifact.body.split(/\s+/).filter(Boolean).length;
      } catch (error) { out.artifacts[path] = `error: ${String(error.message ?? error).slice(0, 80)}`; }
    }
    return out;
  } catch (error) {
    return { host: site.host, repo: site.repo, label: site.label, path: site.path, error: String(error.message ?? error).slice(0, 160) };
  }
}

async function newestEarlierReport(week) {
  let names;
  try { names = await readdir(REPORT_DIR); } catch { return null; }
  const earlier = names.filter((n) => /^\d{4}-W\d{2}\.json$/.test(n) && n.replace('.json', '') < week).sort();
  if (!earlier.length) return null;
  const name = earlier.at(-1);
  try { return { week: name.replace('.json', ''), report: JSON.parse(await readFile(join(REPORT_DIR, name), 'utf8')) }; }
  catch { return null; }
}

function markdownOf(report) {
  const arrow = (d) => (d.delta > 0 ? `+${d.delta}` : String(d.delta));
  const lines = [
    `# Weekly outcome report — ${report.week}`,
    '',
    `Measured ${report.generated_at}. Compared with ${report.compared_with ?? 'nothing — this is the first report'}.`,
    '',
    '| Host | Status | Load | Red | Week over week |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const site of report.sites) {
    const wow = site.deltas ? Object.entries(site.deltas).map(([k, d]) => `${k} ${arrow(d)}`).join(', ') : '—';
    lines.push(`| ${site.host} | ${site.error ? 'error' : site.status} | ${site.ms ? `${site.ms} ms` : '—'} | ${site.red.length ? site.red.join('; ') : 'green'} | ${wow} |`);
  }
  const red = report.sites.filter((s) => s.red.length);
  lines.push('', red.length ? `## Red: ${red.length} of ${report.sites.length}` : `## All ${report.sites.length} hosts green`);
  for (const site of red) lines.push(`- **${site.host}** (fix in \`${site.repo}\`): ${site.red.join('; ')}`);
  return lines.join('\n') + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const config = JSON.parse(await readFile(join(root, 'config/outcome-sites.json'), 'utf8'));
  const sites = config.sites ?? [];
  if (!sites.length) {
    console.error('weekly-outcome-report: config/outcome-sites.json lists no hosts — refusing to report on nothing.');
    process.exit(1);
  }
  if (argv.includes('--self-check')) {
    const problems = [];
    for (const site of sites) {
      for (const field of ['host', 'label', 'repo', 'path', 'expect_status']) if (site[field] === undefined) problems.push(`${site.host ?? '?'}: missing ${field}`);
      if (site.path && !site.path.startsWith('/')) problems.push(`${site.host}: path must start with /`);
      for (const path of site.artifacts ?? []) if (!path.startsWith('/')) problems.push(`${site.host}: artifact ${path} must start with /`);
    }
    if (isoWeek(new Date(Date.UTC(2026, 9, 26))) !== '2026-W44') problems.push(`isoWeek is wrong for 2026-10-26: got ${isoWeek(new Date(Date.UTC(2026, 9, 26)))}`);
    if (isoWeek(new Date(Date.UTC(2027, 0, 1))) !== '2026-W53') problems.push(`isoWeek is wrong for 2027-01-01: got ${isoWeek(new Date(Date.UTC(2027, 0, 1)))}`);
    const red = rednessOf({ path: '/', expect_status: 200 }, { status: 404, ms: 9000, html: true, title: null, artifacts: { '/robots.txt': 404 } });
    if (red.length !== 4) problems.push(`rednessOf should have found four reasons, found ${red.length}: ${red.join('; ')}`);
    if (rednessOf({ path: '/', expect_status: 200 }, { status: 200, ms: 100, html: true, title: 'A Player Mode', artifacts: { '/robots.txt': 200 } }).length) problems.push('rednessOf called a healthy host red');
    const deltas = deltasOf({ status: 200, ms: 400, sitemap_urls: 12 }, { status: 200, ms: 300, sitemap_urls: 10 });
    if (deltas?.sitemap_urls?.delta !== 2 || deltas?.status) problems.push(`deltasOf is wrong: ${JSON.stringify(deltas)}`);
    if (deltasOf({ ms: 1 }, null) !== null) problems.push('deltasOf should return null without an earlier week');
    if (problems.length) {
      console.error(`weekly-outcome-report --self-check FAILED — ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log(`weekly-outcome-report --self-check passed: ${sites.length} hosts configured, ISO weeks, redness and week-over-week deltas all pin correctly.`);
    return;
  }

  const week = isoWeek(new Date());
  const measured = [];
  for (const site of sites) measured.push(await measure(site));
  if (measured.every((m) => m.error)) {
    console.error(`weekly-outcome-report: every one of ${measured.length} hosts failed to answer — reporting nothing would hide it.`);
    for (const m of measured) console.error(`  ✗ ${m.host}: ${m.error}`);
    process.exit(1);
  }
  const earlier = await newestEarlierReport(week);
  for (const m of measured) {
    m.red = rednessOf(sites.find((s) => s.host === m.host), m);
    m.deltas = deltasOf(m, earlier?.report?.sites?.find((s) => s.host === m.host) ?? null);
  }
  const report = {
    schema_version: 1, week, generated_at: new Date().toISOString(),
    compared_with: earlier?.week ?? null,
    hosts: measured.length, red_hosts: measured.filter((m) => m.red.length).length,
    sites: measured,
  };
  const markdown = markdownOf(report);
  console.log(markdown);
  if (argv.includes('--dry-run')) return;
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, `${week}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(REPORT_DIR, `${week}.md`), markdown);
  if (process.env.GITHUB_OUTPUT) {
    const red = report.sites.filter((s) => s.red.length);
    await writeFile(process.env.GITHUB_OUTPUT, [
      `week=${week}`,
      `red_count=${red.length}`,
      `red_hosts=${red.map((s) => s.host).join(' ')}`,
      `report_md=reports/outcomes/${week}.md`,
      `summary=${report.red_hosts ? `${report.red_hosts} of ${report.hosts} hosts red` : `all ${report.hosts} hosts green`}`,
      '',
    ].join('\n'), { flag: 'a' });
  }
  console.error(`weekly-outcome-report: wrote reports/outcomes/${week}.{json,md} — ${report.red_hosts} of ${report.hosts} hosts red.`);
}

await main();
