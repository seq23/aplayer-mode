#!/usr/bin/env node
/**
 * THE SPRY LABS WEEKLY HAND-OFF (owner, 1 Nov 2026). This repo no longer emails its weekly report.
 * It writes spry-weekly-summary.json (schema spry-weekly-summary-v1) and the workflow uploads it as
 * the artifact `spry-weekly-summary`. Boss OS reads the newest one on Wednesday at 08:15 Central and
 * puts one short section for A Player Mode into the one "Spry Labs weekly" email.
 *
 *   node .github/scripts/spry-weekly-summary.mjs reports/outcomes/<week>.json [out.json]
 *
 * Facts only, no prose styling: Boss OS words them. Rule 0: a report with no sites is a failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function summarise(report, runUrl = null) {
  const sites = (report.sites ?? []).map((s) => ({
    host: s.host,
    label: s.label ?? null,
    state: (s.red ?? []).length ? 'needs-a-look' : 'fine',
    why: (s.red ?? []).slice(0, 3),
  }));
  if (sites.length === 0) throw new Error('NAMED STOP [NO_SITES] the weekly report measured no sites; nothing to hand to Boss OS.');
  return {
    schema: 'spry-weekly-summary-v1', business: 'A Player Mode', week: report.week,
    generated_at: report.generated_at ?? new Date().toISOString(), run_url: runUrl, sites, notes: [],
  };
}

/** Proves the hand-off before CI trusts it: a red site is "needs-a-look", and zero sites refuses. */
export function selfCheck() {
  const ok = summarise({ week: '2026-W45', sites: [{ host: 'a.example', red: [] }, { host: 'b.example', red: ['/ answered 500, expected 200'] }] });
  if (ok.schema !== 'spry-weekly-summary-v1' || ok.sites[1].state !== 'needs-a-look' || ok.sites[0].state !== 'fine') throw new Error('self-check: states are wrong');
  let refused = false;
  try { summarise({ week: '2026-W45', sites: [] }); } catch { refused = true; }
  if (!refused) throw new Error('self-check: an empty report was handed on (rule 0)');
  console.log('spry-weekly-summary self-check: ok');
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === '--self-check') selfCheck();
else if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, out = 'spry-weekly-summary.json'] = process.argv.slice(2);
  const runUrl = process.env.RUN_URL ?? null;
  const summary = summarise(JSON.parse(readFileSync(input, 'utf8')), runUrl);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`spry weekly summary: ${summary.sites.length} site(s), ${summary.sites.filter((s) => s.state !== 'fine').length} need a look -> ${out}`);
}
