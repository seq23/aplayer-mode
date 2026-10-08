// Which build this is, and so where it may take payment (docs/33 §9). Pure: no React Native
// imports, so apps/mobile/test runs it in Node.
//
//   store    — an App Store / Google Play build. Buys ONLY through the store (RevenueCat SDK).
//              Never renders, links to or builds a web checkout (App Store 3.1.1, Play payments).
//   sideload — the Android APK downloaded from aplayermode.com (scripts/build-android-apk.sh).
//              No store to buy from: card checkout (RevenueCat Web Billing).
//   web      — the web app (app.aplayermode.com). Card checkout.
//
// The flag is EXPO_PUBLIC_APM_DISTRIBUTION, inlined at build time. Fail closed: iOS is
// ALWAYS `store` whatever the flag says, and a native build without the flag is `store`.
export type Distribution = 'store' | 'sideload' | 'web';

export function resolveDistribution(platformOS: string, flag: string | undefined): Distribution {
  if (platformOS === 'web') return 'web';
  if (platformOS === 'android' && flag === 'sideload') return 'sideload';
  return 'store';
}

/** Card checkout (RevenueCat Web Billing) exists ONLY in the web app and the sideload APK. */
export function webCheckoutAllowed(distribution: Distribution): boolean {
  return distribution === 'web' || distribution === 'sideload';
}

/** The build flag as inlined by Expo (static member access, so babel-preset-expo inlines it). */
export const DISTRIBUTION_FLAG: string | undefined = process.env.EXPO_PUBLIC_APM_DISTRIBUTION;
