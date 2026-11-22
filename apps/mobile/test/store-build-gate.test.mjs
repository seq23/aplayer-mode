// The store build gate (scripts/store-build-gate.mjs, the eas-build-pre-install hook): a production
// Android build refuses a missing or non-Google RevenueCat key, a production iOS build a non-Apple
// one, and EAS really runs the gate (package.json hook), as a process whose exit code stops the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { storeBuildGate } from '../scripts/store-build-gate.mjs';

const run = promisify(execFile);
const appDir = fileURLToPath(new URL('../', import.meta.url));
const GOOG = 'goog_AbCdEfGhIjKlMnOpQrStUvWxYz1';
const APPL = 'appl_AbCdEfGhIjKlMnOpQrStUvWxYz1';
const android = (key) => ({ EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android', ...(key === undefined ? {} : { EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: key }) });

test('android production: refuses no key, an empty key, an Apple key and a stub; passes a Google key', () => {
  assert.match(storeBuildGate(android()).line, /REVENUECAT_KEY_MISSING/);
  assert.equal(storeBuildGate(android('  ')).ok, false);
  assert.match(storeBuildGate(android(APPL)).line, /REVENUECAT_KEY_WRONG/);
  assert.equal(storeBuildGate(android('goog_')).ok, false);
  const pass = storeBuildGate(android(GOOG));
  assert.equal(pass.ok, true);
  assert.ok(!pass.line.includes(GOOG), 'the key value is never printed');
});

test('ios production: needs an Apple key; the Android key does not count', () => {
  const ios = { EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'ios', EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: GOOG };
  assert.equal(storeBuildGate(ios).ok, false);
  assert.equal(storeBuildGate({ ...ios, EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: APPL }).ok, true);
});

test('a production build with no platform never passes; preview and development are not gated', () => {
  assert.match(storeBuildGate({ EAS_BUILD_PROFILE: 'production' }).line, /STORE_BUILD_PLATFORM_UNKNOWN/);
  assert.equal(storeBuildGate({ EAS_BUILD_PROFILE: 'preview', EAS_BUILD_PLATFORM: 'android' }).ok, true);
  assert.equal(storeBuildGate({ EAS_BUILD_PROFILE: 'development', EAS_BUILD_PLATFORM: 'ios' }).ok, true);
});

test('EAS runs the gate before install, and its exit code stops the build', async () => {
  const pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['eas-build-pre-install'], 'node scripts/store-build-gate.mjs');
  const script = join(appDir, 'scripts/store-build-gate.mjs');
  const base = { PATH: process.env.PATH, EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android' };
  await assert.rejects(run(process.execPath, [script], { env: base }), (err) => err.code === 1 && /REVENUECAT_KEY_MISSING/.test(err.stderr));
  const { stdout } = await run(process.execPath, [script], { env: { ...base, EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: GOOG } });
  assert.match(stdout, /^OUTPUT store-build-gate: android production build/);
});
