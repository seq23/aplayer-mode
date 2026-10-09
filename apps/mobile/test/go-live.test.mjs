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
  const dated = { 'public/terms/index.html': '2026-10-07', 'public/privacy/index.html': '2026-10-08', 'public/privacy/consumer-health/index.html': '2026-10-08' };
  for (const [page, date] of Object.entries(dated)) {
    const html = await read(page);
    assert.match(html, new RegExp(`Last updated ${date}`));
    assert.match(html, /Spry Labs/);
    assert.match(html, /support@aplayermode\.com/);
    assert.ok(html.length > 6000, `${page} is a full policy`);
  }
  const terms = await read('public/terms/index.html');
  for (const must of [/No free trial/, /Autopilot never spends your money/, /not medical/i, /auto-renew/i]) assert.match(terms, must);
  const privacy = await read('public/privacy/index.html');
  for (const must of [/OpenRouter/, /United States/, /Export/, /Delete/, /Limited Use/]) assert.match(privacy, must);
  // The privacy policy links the consumer health data policy (owner, 8 Oct 2026), and states the 18+ confirmation.
  assert.match(privacy, /href="\/privacy\/consumer-health"/);
  assert.match(privacy, /confirm you are 18 or older before an account is created/);
});

test('the Consumer Health Data Privacy Policy matches what the app collects and the version it asks consent for', async () => {
  const html = await read('public/privacy/consumer-health/index.html');
  const CONSUMER_HEALTH_POLICY_VERSION = (await read('../../packages/planning/src/intake/healthData.ts')).match(/CONSUMER_HEALTH_POLICY_VERSION = '(\d{4}-\d{2}-\d{2})'/)[1];
  assert.match(html, new RegExp(`Policy version ${CONSUMER_HEALTH_POLICY_VERSION}`), 'the page carries the version a grant is recorded against');
  // Every health item the intake gates is named on the page (packages/planning/src/intake/healthData.ts).
  for (const must of [/movement/, /food habits/, /current weight/, /weigh in/, /health routine/, /pregnancy/, /diabetes medication/, /heart condition/, /disordered eating/, /clinician/, /getting out of bed/, /Pilates-style/, /Losing weight \/ getting healthy/, /return from an injury/]) assert.match(html, must);
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
