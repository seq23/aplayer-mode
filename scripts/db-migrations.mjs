#!/usr/bin/env node
// Brings the production database up to the repo before an API deploy: every
// services/api/migrations/NNNN_*.sql not yet in the Supabase migration ledger is applied, in number
// order, through the Management API (POST /v1/projects/{ref}/database/migrations, the way every
// migration since 0099 was applied), named after its file. Then the ledger is read again and must
// hold every file. Any doubt refuses (exit 2) and nothing deploys:
//   - no SUPABASE_ACCESS_TOKEN, or the ledger cannot be read or comes back empty (outage: never
//     read as "nothing applied", which would re-run all 70+ files);
//   - a pending file numbered BELOW one already applied (a gap: applied by hand under another name,
//     or skipped). Only the new tail is ever applied automatically;
//   - a migration the database rejects (the rest stay unapplied).
// Replaces the hand-kept REQUIRED_RPCS probe list, which every new migration had to remember to
// extend (the 0107 outage, 21 Nov 2026: `land` deployed a Worker whose migration was not applied).
//
//   node scripts/db-migrations.mjs            (from the repo root; SUPABASE_ACCESS_TOKEN in env)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANAGEMENT_API = 'https://api.supabase.com/v1';

// Files applied before the ledger named migrations after their file. 0001–0003 are recorded under
// their old names; 0093–0098 were applied as raw SQL and are not in the ledger at all (their
// functions and tables were confirmed present in production on 21 Nov 2026 by a read-only
// pg_proc / to_regclass query). Nothing new is ever added here.
export const RECORDED_ELSEWHERE = {
  '0001_life_graph': 'life_graph_rls_baseline',
  '0002_life_graph_rpc': 'life_graph_rpc_baseline',
  '0003_lock_down_profile_trigger': 'lock_down_profile_trigger_function',
  '0093_age_gate_and_health_consent': null,
  '0094_mood_under_health_consent': null,
  '0095_launch_update_signups': null,
  '0096_billing_checkout_links': null,
  '0097_billing_founding_pending_checkouts': null,
  '0098_billing_renewal_reminders': null,
};

export class Refusal extends Error {}

/** Ordered migration stems (file names without .sql). */
export function migrationFiles(dir) {
  return fs.readdirSync(dir).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort().map((n) => n.slice(0, -4));
}

/** Which files still need applying, given the ledger's names. Throws Refusal on any doubt. */
export function pendingMigrations(files, ledgerNames) {
  if (!Array.isArray(ledgerNames) || ledgerNames.length === 0) {
    throw new Refusal('the migration ledger came back empty; refusing rather than re-running every migration');
  }
  const ledger = new Set(ledgerNames);
  const applied = (stem) => stem in RECORDED_ELSEWHERE
    || ledger.has(stem) || ledger.has(stem.replace(/^\d+_/, ''));
  const lastApplied = files.reduce((last, stem, i) => (applied(stem) ? i : last), -1);
  if (lastApplied === -1) throw new Refusal('no repo migration is in the ledger; wrong project?');
  const pending = files.filter((stem) => !applied(stem));
  const gaps = pending.filter((stem) => files.indexOf(stem) < lastApplied);
  if (gaps.length) {
    throw new Refusal(`${gaps.join(', ')} not in the ledger but older than ${files[lastApplied]}: apply or record by hand (RUNBOOK → Deploy), never automatically`);
  }
  return pending;
}

async function readLedger(ref, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${MANAGEMENT_API}/projects/${ref}/database/migrations`, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new Refusal(`the migration ledger could not be read (${error.message})`);
  }
  if (!response.ok) throw new Refusal(`the migration ledger could not be read (HTTP ${response.status})`);
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Refusal('the migration ledger answer was not a list');
  return rows.map((row) => row.name);
}

/** Applies every pending migration in order, then proves the ledger holds them all. */
export async function syncMigrations({ dir, ref, token, fetchImpl = fetch, log = console.log }) {
  if (!token) throw new Refusal('NAMED STOP [SUPABASE_ACCESS_TOKEN_MISSING] run the deploy inside the Boss OS vault (land does)');
  if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Refusal(`no Supabase project ref (got "${ref}")`);
  const files = migrationFiles(dir);
  const pending = pendingMigrations(files, await readLedger(ref, token, fetchImpl));
  for (const stem of pending) {
    const query = fs.readFileSync(path.join(dir, `${stem}.sql`), 'utf8');
    const response = await fetchImpl(`${MANAGEMENT_API}/projects/${ref}/database/migrations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: stem, query }),
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Refusal(`migration ${stem} failed (HTTP ${response.status}): ${detail}`);
    }
    log(`migration applied: ${stem}`);
  }
  const after = pendingMigrations(files, await readLedger(ref, token, fetchImpl));
  if (after.length) throw new Refusal(`applied but not in the ledger: ${after.join(', ')}`);
  log(`OUTPUT migrations: ${pending.length} applied, ${files.length} in the ledger`);
  return pending;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wrangler = fs.readFileSync(path.join(root, 'services/api/wrangler.jsonc'), 'utf8');
  const ref = (wrangler.match(/"SUPABASE_URL": "https:\/\/([a-z0-9]+)\.supabase\.co"/) || [])[1];
  syncMigrations({ dir: path.join(root, 'services/api/migrations'), ref, token: process.env.SUPABASE_ACCESS_TOKEN })
    .catch((error) => {
      console.error(`refusing: ${error.message}`);
      process.exit(error instanceof Refusal ? 2 : 1);
    });
}
