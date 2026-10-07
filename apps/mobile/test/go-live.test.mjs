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
  for (const page of ['public/terms/index.html', 'public/privacy/index.html']) {
    const html = await read(page);
    assert.match(html, /Last updated 2026-10-07/);
    assert.match(html, /Spry Labs/);
    assert.match(html, /support@aplayermode\.com/);
    assert.ok(html.length > 6000, `${page} is a full policy`);
  }
  const terms = await read('public/terms/index.html');
  for (const must of [/No free trial/, /Autopilot never spends your money/, /not medical/i, /auto-renew/i]) assert.match(terms, must);
  const privacy = await read('public/privacy/index.html');
  for (const must of [/OpenRouter/, /United States/, /Export/, /Delete/, /Limited Use/]) assert.match(privacy, must);
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
