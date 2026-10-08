// RevenueCat client (docs/33-BILLING-PHASE-D.md). The SDK talks to the store; the APM
// server is told about purchases ONLY by RevenueCat's verified webhook. Nothing here
// reports a purchase to the APM API, and nothing the SDK returns grants a plan: the app
// re-reads /v1/product/plan for that.
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import Purchases, { type PurchasesOffering, type PurchasesPackage } from 'react-native-purchases';
import type { StoreChannel } from '@apm/policy';
import { DISTRIBUTION_FLAG, resolveDistribution, type Distribution } from './distribution';

export type BillingAvailability =
  | { available: true; store: StoreChannel }
  | { available: false; reason: 'web' | 'sideload' | 'expo_go' | 'not_configured' };

/** This build's distribution (store / sideload / web), from EXPO_PUBLIC_APM_DISTRIBUTION; fail closed to store. */
export function appDistribution(): Distribution {
  return resolveDistribution(Platform.OS, DISTRIBUTION_FLAG);
}

function apiKey(): string | undefined {
  if (Platform.OS === 'ios') return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY || undefined;
  if (Platform.OS === 'android') return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY || undefined;
  return undefined;
}

export function billingAvailability(): BillingAvailability {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { available: false, reason: 'web' };
  // The sideload APK is not from Google Play: there is no store to buy from (card checkout instead).
  if (appDistribution() === 'sideload') return { available: false, reason: 'sideload' };
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return { available: false, reason: 'expo_go' };
  if (!apiKey()) return { available: false, reason: 'not_configured' };
  return { available: true, store: Platform.OS === 'ios' ? 'app_store' : 'google_play' };
}

export const UNAVAILABLE_COPY: Record<Extract<BillingAvailability, { available: false }>['reason'], string> = {
  web: 'Plans are paid by card here. Your plan follows your account to every device you sign in on.',
  sideload: 'Plans are paid by card in this version of the app. Your plan follows your account to every device you sign in on.',
  expo_go: 'In-app purchases need the A Player Mode app build; Expo Go cannot make purchases.',
  not_configured: 'In-app purchases are not configured in this build yet.',
};

export function legalUrls(store: StoreChannel | 'web' | undefined, appleEula: string): { termsUrl?: string; privacyUrl?: string } {
  const terms = process.env.EXPO_PUBLIC_TERMS_URL || (store === 'app_store' ? appleEula : undefined);
  return { termsUrl: terms || undefined, privacyUrl: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || undefined };
}

let configuredFor: string | null = null;

/** Configures (or switches) RevenueCat to this Supabase user id. Never anonymous. */
export async function identifyBillingUser(userId: string): Promise<void> {
  const availability = billingAvailability();
  if (!availability.available || !userId) return;
  if (configuredFor === userId) return;
  if (configuredFor === null && !(await Purchases.isConfigured())) {
    Purchases.configure({ apiKey: apiKey()!, appUserID: userId });
  } else {
    await Purchases.logIn(userId);
  }
  configuredFor = userId;
}

/** On sign-out: the next person on this device must not inherit the previous user's purchases. */
export async function forgetBillingUser(): Promise<void> {
  if (configuredFor === null) return;
  configuredFor = null;
  try { await Purchases.logOut(); } catch { /* already anonymous or not configured */ }
}

export async function loadOffering(offeringId: string): Promise<PurchasesOffering | undefined> {
  const offerings = await Purchases.getOfferings();
  return offerings.all[offeringId] ?? undefined;
}

export type PurchaseOutcome = 'purchased' | 'cancelled';

export async function buyPackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    await Purchases.purchasePackage(pkg);
    return 'purchased';
  } catch (error) {
    if ((error as { userCancelled?: boolean } | undefined)?.userCancelled) return 'cancelled';
    throw error;
  }
}

export async function restoreStorePurchases(): Promise<void> {
  await Purchases.restorePurchases();
}

export async function managementUrl(): Promise<string | undefined> {
  try { return (await Purchases.getCustomerInfo()).managementURL ?? undefined; } catch { return undefined; }
}
