// The 18+ confirmation and the consumer health data consent in the app (server migration 0093):
// "Start" asks 18+ first and the health-data choice second, before any question or session;
// the whole app sits under a gate that shows the age screen to any signed-in person the
// server has no confirmation for (existing accounts on their next launch); Settings → Privacy
// has the health-data screen with withdraw, the policy link and Export & Delete; the policy
// page ships with the build and the privacy policy links it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const src = (rel) => readFile(join(appDir, rel), 'utf8');

test('Start: 18+ first, the health-data choice second, then the questions; nothing starts a session before them', async () => {
  const welcome = await src('app/welcome.tsx');
  const start = welcome.slice(welcome.indexOf('const start = () => {'));
  const order = ["router.push('/age')", "router.push('/health-consent')", 'startAnonymous()', "router.push('/intake')"].map((s) => start.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), `order ${order}`);
  assert.match(await src('app/age.tsx'), /router\.replace\('\/health-consent'\)/);
  const health = await src('app/health-consent.tsx');
  assert.ok(health.indexOf('startAnonymous') < health.indexOf("router.replace('/intake')"));
});

test('the gate covers every signed-in screen: the age screen for accounts the server has no 18+ for, then the health choice once', async () => {
  const layout = await src('app/_layout.tsx');
  assert.match(layout, /<ConsentProvider>\s*<ThemedStack \/>\s*<\/ConsentProvider>/);
  assert.match(layout, /<\/Stack>\s*<ConsentGate \/>/, 'drawn over the navigator, which stays mounted');
  const views = await src('src/components/consent/ConsentViews.tsx');
  assert.match(views, /needsAge \? <AgeGateView \/> : <HealthConsentView \/>/);
  const state = await src('src/state/consent.tsx');
  assert.match(state, /needsAge: signedIn && server !== undefined && !server\.ageConfirmedAt/);
  assert.match(state, /removeSync\(AGE_KEY\)/, 'sign-out forgets the device tap');
  // "Under 18" creates nothing: an anonymous session is signed out; an account is offered deletion.
  assert.match(views, /status === 'signed_in' && isAnonymous\) await signOut\(\)/);
  assert.match(views, /requestDeletion\(accessToken\)/);
});

test('the API client sends only an explicit confirmation and a versioned grant', async () => {
  const api = await src('src/api/apmApi.ts');
  assert.match(api, /'\/v1\/consents\/age', accessToken, \{ method: 'POST', body: JSON\.stringify\(\{ confirmed: true \}\) \}/);
  assert.match(api, /decision === 'granted' \? \{ decision, policyVersion \} : \{ decision \}/);
});

test('Settings → Privacy → Consumer health data: withdraw, the policy, and Export & Delete', async () => {
  const index = await src('app/settings/privacy/index.tsx');
  assert.match(index, /title: 'Consumer health data'[\s\S]*?href: '\/settings\/privacy\/health-data'/);
  const screen = await src('app/settings/privacy/health-data.tsx');
  assert.match(screen, /decideHealth\('withdrawn'\)/);
  assert.match(screen, /router\.push\('\/settings\/privacy\/export-delete'\)/);
  assert.match(screen, /legalPageUrl\('consumer-health'\)/);
  assert.match(await src('app/_layout.tsx'), /name="settings\/privacy\/health-data"/);
  assert.match(await src('src/links/external.ts'), /`\$\{privacy\}\/consumer-health`/);
  await access(join(appDir, 'public/privacy/consumer-health/index.html'));
});
