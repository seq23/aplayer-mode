import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// App Review 27 Nov 2026: ~/.config/aplayermode/secrets held a stale 8-character APP_REVIEW_CODE.
// The real script runs here with stub tools, and only the Worker secrets it uploads are recorded.
test('a --secrets-dir deploy never uploads APP_REVIEW_CODE, and still uploads the other Worker secrets', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync: read, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const bin = mkdtempSync(join(tmpdir(), 'apm-deploy-bin-'));
  const secrets = mkdtempSync(join(tmpdir(), 'apm-deploy-secrets-'));
  const log = join(bin, 'uploads');
  writeFileSync(join(secrets, 'APP_REVIEW_CODE'), 'abcd1234');
  writeFileSync(join(secrets, 'OPENROUTER_API_KEY'), 'fixture-key');
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\n[ "$2" = "secret" ] && [ "$3" = "put" ] && echo "$4" >> "${log}"\ncat >/dev/null 2>&1 </dev/null\nexit 0\n`);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\necho "{}"\n');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho 0000000\n');
  for (const tool of ['npx', 'npm', 'node', 'curl', 'git']) chmodSync(join(bin, tool), 0o755);
  const run = spawnSync('bash', [join(root, 'scripts/deploy-api-production.sh'), '--secrets-dir', secrets], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const uploaded = existsSync(log) ? read(log, 'utf8').trim().split('\n') : [];
  assert.deepEqual(uploaded, ['OPENROUTER_API_KEY']);
  assert.match(run.stdout, /skipped APP_REVIEW_CODE: set it from vault APM_APPLE_REVIEW_PASSWORD/);
  assert.doesNotMatch(run.stdout + run.stderr, /abcd1234/, 'the code is never printed');
});
