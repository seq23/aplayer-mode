#!/usr/bin/env node
// App Store pre-submit check (docs/35 §4). Fails (exit 1) on anything App Review rejects
// that the code can show:
//   1. "Coming soon" / placeholder copy anywhere in the app;
//   2. Stripe (digital subscriptions must use in-app purchase, Guideline 3.1.1);
//   3. an http(s) link or Linking.openURL outside the external-link helper
//      (src/links/external.ts opens the system browser), or any in-app webview;
//   4. app.json not making the iPad decision (ios.supportsTablet must be false: the
//      layouts are phone layouts, so iPad runs the iPhone app).
// Usage: node scripts/presubmit-ios.mjs [appDir]   (default apps/mobile)
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appDir = resolve(process.argv[2] ?? join(root, 'apps/mobile'));

/** Files allowed to hold https literals, and why. Each is data handed to openExternal, never opened directly. */
export const LINK_ALLOWLIST = {
  'src/links/external.ts': 'the helper itself',
  'src/billing/catalog.ts': 'store subscription-management and Apple EULA URLs, opened through openExternal',
  'app/settings/privacy/connections.tsx': 'OAuth scope identifiers shown as text, never opened',
};

async function sources(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...await sources(path)); }
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const violations = [];
const files = [...await sources(join(appDir, 'app')), ...await sources(join(appDir, 'src'))];
if (files.length === 0) {
  console.error(`presubmit:ios: NO SOURCE FILES under ${appDir}/app or /src — refusing to pass on nothing.`);
  process.exit(1);
}

for (const file of files) {
  const rel = relative(appDir, file).split('\\').join('/');
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (/coming\s+soon|lorem ipsum|placeholder screen/i.test(line)) violations.push(`${at} placeholder copy ("coming soon"): App Review 2.1 rejects unfinished features`);
    if (/stripe/i.test(line)) violations.push(`${at} Stripe: digital subscriptions must use in-app purchase (3.1.1)`);
    if (/https?:\/\//i.test(line) && !(rel in LINK_ALLOWLIST)) violations.push(`${at} http(s) link outside the external-link helper: route it through openExternal (src/links/external.ts)`);
    if (/Linking\.openURL/.test(line) && rel !== 'src/links/external.ts') violations.push(`${at} Linking.openURL outside src/links/external.ts: use openExternal`);
    if (/openBrowserAsync|react-native-webview|<WebView\b/.test(line)) violations.push(`${at} in-app webview: external pages open in the system browser`);
  });
}

let appJson;
try { appJson = JSON.parse(await readFile(join(appDir, 'app.json'), 'utf8')); } catch { violations.push('app.json missing or unreadable'); }
if (appJson) {
  if (appJson.expo?.ios?.supportsTablet !== false) violations.push('app.json: expo.ios.supportsTablet must be false (phone layouts; iPad runs the iPhone app)');
  if (/coming\s+soon/i.test(JSON.stringify(appJson))) violations.push('app.json: placeholder copy ("coming soon")');
}
try {
  const pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) if (/stripe/i.test(dep)) violations.push(`package.json: ${dep} (Stripe SDK in the app)`);
} catch { /* no package.json is not a store build */ }

if (violations.length) {
  console.error(`presubmit:ios FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(`presubmit:ios passed: ${files.length} files scanned; no placeholders, no Stripe, links only via openExternal, iPad = iPhone app.`);
