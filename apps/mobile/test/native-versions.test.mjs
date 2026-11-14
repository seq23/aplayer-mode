// iOS 1.0 build 3 crashed on open: react-native was pinned to 0.88.0-rc.3 while Expo SDK 58's
// precompiled iOS binaries (ExpoModulesCore) are built against 0.88.1, and react-native-screens was
// installed twice (4.28 at the root, 4.30 nested under expo-router). The web preview never runs
// native code, so only a store build showed it. This holds every native package to the version the
// installed Expo SDK ships with, and to exactly one installed copy, before an EAS build can start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(appDir, 'package.json'));
const semver = require('semver');
const app = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const expected = require('expo/bundledNativeModules.json');
const installed = (name) => require(`${name}/package.json`).version;
const pinned = Object.entries({ ...app.dependencies, ...app.devDependencies }).filter(([name]) => name in expected);

test('every native package the app declares is the version its Expo SDK ships with', () => {
  assert.ok(pinned.length >= 10, `expected the app's native packages in bundledNativeModules.json, saw ${pinned.length}`);
  const wrong = pinned
    .map(([name, declared]) => ({ name, declared, want: expected[name], have: installed(name) }))
    .filter(({ want, have }) => !semver.satisfies(have, want))
    .map(({ name, declared, want, have }) => `${name}: declared ${declared}, installed ${have}, SDK wants ${want}`);
  assert.deepEqual(wrong, [], 'run `npx expo install --fix` in apps/mobile');
});

test('react-native is a release, never a release candidate', () => {
  assert.equal(semver.prerelease(installed('react-native')), null, `react-native ${installed('react-native')}`);
  assert.equal(semver.prerelease(app.dependencies['react-native']), null);
});

test('each native package is installed once (a nested copy ships two versions of native code)', () => {
  const root = dirname(dirname(require.resolve('expo/package.json')));
  const nested = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const names = entry.name.startsWith('@') ? readdirSync(join(dir, entry.name)).map((n) => `${entry.name}/${n}`) : [entry.name];
      for (const name of names) {
        const inner = join(dir, name, 'node_modules');
        if (!existsSync(inner)) continue;
        for (const native of Object.keys(expected)) {
          if (existsSync(join(inner, native, 'package.json'))) nested.push(`${name}/node_modules/${native}`);
        }
      }
    }
  };
  scan(root);
  assert.ok(existsSync(join(root, 'react-native-screens')), `scanned ${root} but react-native-screens is not there`);
  assert.deepEqual(nested, [], 'dedupe these: npx expo install --fix, then npm dedupe');
});
