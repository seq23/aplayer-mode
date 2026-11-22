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
