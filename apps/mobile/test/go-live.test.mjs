// Phase E go-live (docs/33 §8): one web origin everywhere, real legal pages, an installable web
// app, and production never accepting sandbox purchases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const WEB = 'https://app.aplayermode.com';
const API = 'https://api.aplayermode.com';

test('production API config: the web origin, the custom domain, and no sandbox billing', async () => {
  const wrangler = await read('../../services/api/wrangler.jsonc');
  const production = wrangler.slice(wrangler.indexOf('"production": {'));
  assert.match(production, /"pattern": "api\.aplayermode\.com", "custom_domain": true/);
  assert.match(production, new RegExp(`"ALLOWED_ORIGIN": "${WEB}"`));
  assert.match(production, new RegExp(`"APP_PUBLIC_URL": "${WEB}"`));
  assert.doesNotMatch(wrangler, /"BILLING_ALLOW_SANDBOX"\s*:/, 'sandbox purchases are never a committed var');
  assert.doesNotMatch(wrangler, /sb_secret_|OPENROUTER_API_KEY"\s*:/, 'no secret in the committed config');
  const deploy = await read('../../scripts/deploy-api-production.sh');
  assert.match(deploy, /BILLING_ALLOW_SANDBOX\) echo "refusing/);
  assert.match(deploy, /wrangler deploy --env production/);
});

test('store and web builds point at the same API and the hosted Terms and Privacy pages', async () => {
  const eas = JSON.parse(await read('eas.json'));
  for (const profile of ['preview', 'production']) {
    assert.equal(eas.build[profile].env.EXPO_PUBLIC_APM_API_URL, API);
    assert.equal(eas.build[profile].env.EXPO_PUBLIC_TERMS_URL, `${WEB}/terms`);
    assert.equal(eas.build[profile].env.EXPO_PUBLIC_PRIVACY_POLICY_URL, `${WEB}/privacy`);
  }
  const web = await read('../../scripts/deploy-web-production.sh');
  assert.match(web, new RegExp(`EXPO_PUBLIC_TERMS_URL="${WEB}/terms"`));
  assert.match(web, new RegExp(`EXPO_PUBLIC_PRIVACY_POLICY_URL="${WEB}/privacy"`));
  assert.match(web, new RegExp(`EXPO_PUBLIC_APM_API_URL="${API}"`));
});

test('the legal pages are real, dated, and name the entity and contact', async () => {
  const dated = { 'public/terms/index.html': '2026-11-21', 'public/privacy/index.html': '2026-11-21', 'public/privacy/consumer-health/index.html': '2026-10-08' };
  for (const [page, date] of Object.entries(dated)) {
    const html = await read(page);
    assert.match(html, new RegExp(`Last updated ${date}`));
    assert.match(html, /Spry Labs/);
    assert.match(html, /support@aplayermode\.com/);
    assert.ok(html.length > 6000, `${page} is a full policy`);
  }
  const terms = await read('public/terms/index.html');
  for (const must of [/No free trial/, /Autopilot never spends your money/, /not medical/i, /auto-renew/i, /pay by card/, /Settings → Plan → Manage subscription/, /988/, /roles played by software, not people/]) assert.match(terms, must);
  // Card checkout is live (web app and Android download): the Terms may never again say the web app does not sell.
  assert.doesNotMatch(terms, /web app does not sell subscriptions/);
  const privacy = await read('public/privacy/index.html');
  for (const must of [/OpenRouter/, /United States/, /Export/, /Delete/, /Limited Use/, /Stripe/, /Microsoft Clarity/, /aplayermode\.com/]) assert.match(privacy, must);
  // The privacy policy links the consumer health data policy (owner, 8 Oct 2026), and states the 18+ confirmation.
  assert.match(privacy, /href="\/privacy\/consumer-health"/);
  assert.match(privacy, /confirm you are 18 or older before you can use an account/);
  // Google OAuth verification compares the policy to the scopes we request: every Google scope the
  // policy names must be one the API asks for (no Gmail in v1, her call 21 Nov 2026).
  const googleScopes = new Set([...(await read('../../services/api/src/connectors/oauth.ts')).matchAll(/googleapis\.com\/auth\/([a-z.]+)/g)].map((m) => m[1]));
  assert.ok(googleScopes.size > 0, 'read the API scopes');
  const googleItem = privacy.match(/<li>Google:[\s\S]*?<\/li>/)?.[0] ?? '';
  const named = [...googleItem.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1].replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''));
  assert.ok(named.length > 0, 'the policy names its Google scopes');
  for (const scope of named) assert.ok(googleScopes.has(scope), `policy names ${scope}, which the API never requests`);
  // Privacy claims match the code (FTC Act s.5): the policy, the iOS permission prompt and the
  // device-calendar sync agree on whether the person picks calendars (calendarClaimsAgree below).
  const deviceCalendar = await read('src/integrations/deviceCalendar.ts');
  const app = JSON.parse(await read('app.json')).expo;
  const prompt = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-calendar')[1].calendarPermission;
  assert.deepEqual(calendarClaimsAgree({ policy: privacy, code: deviceCalendar, prompt, appVersion: app.version }), []);
  for (const field of [/title/, /location/, /organizer's name/, /14 days ago to 90 days ahead/]) assert.match(privacy, field);
});

test('the Consumer Health Data Privacy Policy matches what the app collects and the version it asks consent for', async () => {
  const html = await read('public/privacy/consumer-health/index.html');
  const CONSUMER_HEALTH_POLICY_VERSION = (await read('../../packages/planning/src/intake/healthData.ts')).match(/CONSUMER_HEALTH_POLICY_VERSION = '(\d{4}-\d{2}-\d{2})'/)[1];
  assert.match(html, new RegExp(`Policy version ${CONSUMER_HEALTH_POLICY_VERSION}`), 'the page carries the version a grant is recorded against');
  // Every health item the intake gates is named on the page (packages/planning/src/intake/healthData.ts).
  for (const must of [/movement/, /food habits/, /current weight/, /weigh in/, /health routine/, /pregnancy/, /diabetes medication/, /heart condition/, /disordered eating/, /clinician/, /getting out of bed/, /Pilates-style/, /Losing weight \/ getting healthy/, /1 to 10 score you tap at the morning check-in/, /how full your head feels, from 1 to 10/, /return from an injury/]) assert.match(html, must);
  // The rights the law requires, where they live in the app, and the promises.
  for (const must of [/Settings → Privacy → Consumer health data/, /Settings → Privacy → Export &amp; Delete/, /withdraw/i, /45 days/, /appeal/i, /never sell/i, /not a medical service/, /Supabase/, /Cloudflare/, /OpenRouter/, /support@aplayermode\.com/, /Spry Labs/, /href="\/privacy"/]) assert.match(html, must);
  assert.doesNotMatch(html, /\b(cure|treat(s|ment)? (your|any)|diagnos(e|is)|clinically proven)\b/i, 'no medical claims');
  const web = await read('../../scripts/deploy-web-production.sh');
  assert.match(web, /privacy\/consumer-health\/index\.html/, 'the deploy refuses a build without the page');
});

test('the web app is installable: manifest, icons, standalone', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  const head = await read('scripts/pwa-head.mjs');
  assert.match(head, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(head, /apple-touch-icon/);
});

test('the reviewer address on the Worker is the one on the beta allowlist (0070)', async () => {
  const wrangler = await read('../../services/api/wrangler.jsonc');
  const email = wrangler.match(/"APP_REVIEW_EMAIL": "([^"]+)"/)[1];
  const migration = await read('../../services/api/migrations/0070_app_review_beta.sql');
  assert.match(migration, new RegExp(`values \\('${email.replace('.', '\\.')}', '20\\d\\d-`));
  assert.doesNotMatch(migration, /infinity|9999-/, 'a bounded grant, never permanent');
});

/**
 * Every way the calendar claims can disagree with the code, as plain sentences ([] = they agree).
 * The code "chooses" when getEventsAsync reads only the ids the person ticked; any other
 * getEventsAsync call (every calendar on the phone) "reads all".
 */
function calendarClaimsAgree({ policy, code, prompt, appVersion }) {
  const problems = [];
  const chooses = /chosenCalendars\(\)/.test(code) && /getEventsAsync\(chosenIds\b/.test(code);
  const readsAll = /getEventsAsync\((?!chosenIds\b)/.test(code);
  if (chooses === readsAll) problems.push('device calendar sync changed shape: re-check the Privacy Policy calendar paragraph, then update this test');
  const promise = policy.match(/Version (\d+(?:\.\d+)*) and later:<\/strong> you tick which calendars APM may read, and APM reads only those/);
  const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };
  if (/read on the device only/.test(policy)) problems.push('policy says the calendar is read on the device only; events are uploaded');
  if (chooses) {
    if (!promise) problems.push('the app lets the person pick calendars but the policy does not say so');
    else if (older(appVersion, promise[1])) problems.push(`policy promises a choice from ${promise[1]} but this build is ${appVersion}`);
    if (!/only the calendars you pick/.test(prompt)) problems.push('the iOS permission prompt does not say only the picked calendars are read');
  } else {
    if (promise || /calendars you (choose|pick)/.test(policy)) problems.push('the policy promises a calendar choice while the code reads every calendar');
    if (/calendars you (choose|pick)/.test(prompt)) problems.push('the iOS permission prompt promises a choice while the code reads every calendar');
    if (!/every calendar on your phone/.test(policy)) problems.push('the policy must say every calendar on the phone is read');
  }
  return problems;
}

test('the calendar guard fails on every mismatch between the policy, the prompt and the code', async () => {
  const policy = await read('public/privacy/index.html');
  const code = await read('src/integrations/deviceCalendar.ts');
  const app = JSON.parse(await read('app.json')).expo;
  const prompt = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-calendar')[1].calendarPermission;
  const readsAllCode = 'const calendarIds = calendars.map((calendar) => calendar.id); await Calendar.getEventsAsync(calendarIds, start, end);';
  const noChoicePolicy = policy.replace(/<strong>Version 1\.0\.1 and later:<\/strong>[^]*?<\/li>/, '');
  assert.notEqual(noChoicePolicy, policy, 'the fixture found the promise to remove');
  // Code reads every calendar while the policy and prompt promise a choice.
  assert.ok(calendarClaimsAgree({ policy, code: readsAllCode, prompt, appVersion: app.version }).some((p) => /promises a calendar choice/.test(p)));
  assert.ok(calendarClaimsAgree({ policy: noChoicePolicy, code: readsAllCode, prompt, appVersion: app.version }).some((p) => /prompt promises a choice/.test(p)));
  // Code lets the person pick, but the policy is silent about it.
  assert.ok(calendarClaimsAgree({ policy: noChoicePolicy, code, prompt, appVersion: app.version }).some((p) => /does not say so/.test(p)));
  // The policy promises the choice from a version later than the one being built.
  assert.ok(calendarClaimsAgree({ policy, code, prompt, appVersion: '1.0' }).some((p) => /this build is 1\.0/.test(p)));
  // The prompt does not say only the picked calendars are read.
  assert.ok(calendarClaimsAgree({ policy, code, prompt: 'Allow A Player Mode to read your calendars.', appVersion: app.version }).some((p) => /permission prompt/.test(p)));
  // Old builds that read every calendar stay matched: policy, prompt and code agree.
  assert.deepEqual(calendarClaimsAgree({ policy: noChoicePolicy, code: readsAllCode, prompt: 'A Player Mode reads the events in all calendars on this phone.', appVersion: '1.0' }), []);
});
