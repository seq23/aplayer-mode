#!/usr/bin/env node
// Prints `export NAME='value'` lines for the RevenueCat Web Purchase Links (apps/mobile/web-billing.json),
// for scripts/deploy-web-production.sh and scripts/build-android-apk.sh. An environment variable of the
// same name wins. Refuses (exit 2) anything that is not an https://pay.rev.cat/... link or empty.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAMES = ['EXPO_PUBLIC_RC_WEB_PURCHASE_URL', 'EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING'];
export const LINK = /^https:\/\/pay\.rev\.cat\/[A-Za-z0-9_-]+\/?$/;

export function webBillingEnv(config, env = process.env) {
  const out = {};
  for (const name of NAMES) {
    const value = String(env[name] ?? config[name] ?? '').trim();
    if (value && !LINK.test(value)) throw new Error(`${name} is not a RevenueCat Web Purchase Link (https://pay.rev.cat/<token>)`);
    out[name] = value;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(readFileSync(new URL('../web-billing.json', import.meta.url), 'utf8'));
    for (const [name, value] of Object.entries(webBillingEnv(config))) console.log(`export ${name}='${value}'`);
  } catch (error) { console.error(String(error.message ?? error)); process.exit(2); }
}
