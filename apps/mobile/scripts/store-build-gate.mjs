#!/usr/bin/env node
// Store build gate: EAS runs this as the `eas-build-pre-install` hook on every EAS build, cloud
// or --local. A production (store) binary without the platform's RevenueCat public key would ship
// a paywall that cannot buy, so it is refused before anything is installed:
//   android → EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY must be a Google key (goog_…);
//   ios     → EXPO_PUBLIC_REVENUECAT_IOS_API_KEY must be an Apple key (appl_…).
// Other profiles (development, preview) pass untouched. The keys live in the EAS "production"
// environment (docs/33 §3 step 7); they are never printed, only their prefix is checked.
// Node built-ins only: the hook runs before npm install.
import { pathToFileURL } from 'node:url';

export const STORE_KEYS = {
  android: { name: 'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY', prefix: 'goog_' },
  ios: { name: 'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY', prefix: 'appl_' },
};

/** Returns { ok, line }. Never includes a key value in the line. */
export function storeBuildGate(env) {
  const profile = env.EAS_BUILD_PROFILE;
  const platform = env.EAS_BUILD_PLATFORM;
  if (profile !== 'production') return { ok: true, line: `OUTPUT store-build-gate: profile ${profile ?? '(none)'} is not a store build, nothing to check` };
  const key = STORE_KEYS[platform];
  if (!key) return { ok: false, line: `NAMED STOP [STORE_BUILD_PLATFORM_UNKNOWN] production build with EAS_BUILD_PLATFORM=${platform ?? '(unset)'}: refusing to pass on nothing` };
  const value = (env[key.name] ?? '').trim();
  if (!value) return { ok: false, line: `NAMED STOP [REVENUECAT_KEY_MISSING] ${platform} production build has no ${key.name}: set it in the EAS production environment (docs/33 §3 step 7)` };
  if (!value.startsWith(key.prefix) || value.length < key.prefix.length + 10) {
    return { ok: false, line: `NAMED STOP [REVENUECAT_KEY_WRONG] ${key.name} is not a ${key.prefix}… key: a ${platform} store build would ship a paywall that cannot buy` };
  }
  return { ok: true, line: `OUTPUT store-build-gate: ${platform} production build has a ${key.prefix}… RevenueCat key` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { ok, line } = storeBuildGate(process.env);
  (ok ? console.log : console.error)(line);
  process.exit(ok ? 0 : 1);
}
