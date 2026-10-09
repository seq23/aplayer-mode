import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = readFileSync(join(root, 'scripts/deploy-api-production.sh'), 'utf8');

// The same check the deploy loop runs (from services/api), so the test exercises the real gate.
const declared = (name) => {
  try {
    execFileSync('grep', ['-qE', `^[[:space:]]+${name}\\??:`, 'src/env.ts'], { cwd: join(root, 'services/api') });
    return true;
  } catch { return false; }
};

test('deploy-api-production pushes only Worker-declared secrets from --secrets-dir', () => {
  assert.ok(script.includes('grep -qE "^[[:space:]]+${name}\\??:" src/env.ts || {'), 'the env.ts gate guards wrangler secret put');
  assert.ok(script.indexOf('src/env.ts ||') < script.indexOf('npx wrangler secret put "$name"'), 'the gate runs before the upload');
  for (const name of ['REVENUECAT_API_V2_KEY', 'BILLING_SANDBOX_TESTER_IDS', 'SUPABASE_SECRET_KEY', 'REVENUECAT_WEBHOOK_SECRET']) assert.ok(declared(name), `${name} reaches the Worker`);
  for (const name of ['RC_V2_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_PUBLISHABLE_KEY', 'REVENUECAT']) assert.ok(!declared(name), `${name} never reaches the Worker`);
});

test('deploy-api-production refuses before wrangler when a database function the Worker needs is missing (migrations first)', () => {
  const entries = script.match(/REQUIRED_RPCS="([^"]+)"/)[1].split(/\s+/);
  const required = entries.map((e) => e.split(':')[0]);
  assert.ok(required.includes('apm_my_consents'), 'the 18+ gate reads it on every account route');
  assert.ok(script.indexOf('for entry in $REQUIRED_RPCS') < script.indexOf('npx wrangler deploy'), 'probed before deploying');
  assert.match(script, /\[ "\$code" = "404" \] && \{ echo "refusing: database function \$fn is missing/);
  const migrations = readdirSync(join(root, 'services/api/migrations')).map((name) => readFileSync(join(root, 'services/api/migrations', name), 'utf8')).join('\n');
  const worker = readdirSync(join(root, 'services/api/src')).filter((n) => n.endsWith('.ts')).map((n) => readFileSync(join(root, 'services/api/src', n), 'utf8')).join('\n');
  for (const entry of entries) {
    assert.ok(entry.includes(':'), `${entry} names its parameters (name:p_a,p_b); PostgREST answers 404 for a probe whose parameter set does not match, which reads as "missing"`);
    const [fn, params] = entry.split(':');
    const sig = migrations.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`));
    assert.ok(sig, `${fn} is created by a migration`);
    const names = sig[1].split(',').map((a) => a.trim().split(/\s+/)[0]).filter(Boolean);
    assert.deepEqual(params ? params.split(',') : [], names, `${fn}: the probe sends exactly the function's named parameters`);
    assert.match(worker, new RegExp(`'${fn}'`), `${fn} is called by the Worker`);
  }
});
