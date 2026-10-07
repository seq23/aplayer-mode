import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import type { BillingPeriod, PaidPlan } from '@apm/policy';
import { Body, Button, Card, CardTitle, ChoiceRow, KeyValue, Pill, SectionTitle, uiStyles } from '../components/ui';
import { fetchBillingOffering, fetchProductPlan, type BillingOfferingResponse, type ProductPlanResponse } from '../api/apmApi';
import { useSession } from '../state/session';
import { APPLE_STANDARD_EULA_URL, PAID_PLANS, storeManageUrl, subscriptionDisclosure, tierOffers, type StorePrice } from './catalog';
import { UNAVAILABLE_COPY, billingAvailability, buyPackage, identifyBillingUser, legalUrls, loadOffering, managementUrl, restoreStorePurchases } from './purchases';
import { PLAN_SCREEN, TIER_GRID_WHAT, TIER_GRID_WHO, offerBanner, recommendedTier, type OfferBanner } from '../content/sell';
import { colors, radius, spacing } from '../theme';
import { openExternal } from '../links/external';
import { plainError } from '../api/errors';
import { AccountPanel } from '../components/intake/AccountPanel';

const PLAN_RANK: Record<string, number> = { beta: 0, chief_of_staff: 1, life_os: 2, autopilot: 3, household: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Beta builds only (never a store build): "Start with the closed beta". */
export const CLOSED_BETA_BUILD = process.env.EXPO_PUBLIC_CLOSED_BETA === 'true';

/**
 * The plan choice: the existing Phase D paywall (store disclosures, Restore, Terms and
 * Privacy, no free trial), with the introductory-offer banner and the two tier grids above
 * the purchase options. Used in Settings and as the onboarding step after the OS summary.
 */
export function PlanChoice({ games = [], onboarding = false, onFinished, onProduct }: {
  games?: readonly string[];
  onboarding?: boolean;
  /** Onboarding: purchased, beta, or this build cannot buy → continue to Day 1. */
  onFinished?: (result: 'purchased' | 'beta' | 'continue') => void;
  onProduct?: (product: ProductPlanResponse) => void;
}) {
  const { accessToken, user, isAnonymous } = useSession();
  const availability = useMemo(() => billingAvailability(), []);
  const store = availability.available ? availability.store : undefined;
  const { termsUrl, privacyUrl } = legalUrls(store, APPLE_STANDARD_EULA_URL);
  const [product, setProduct] = useState<ProductPlanResponse>();
  const [serverOffering, setServerOffering] = useState<BillingOfferingResponse>();
  const [storeOffering, setStoreOffering] = useState<PurchasesOffering>();
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const recommended = recommendedTier(games);

  const loadPlan = useCallback(async () => {
    if (!accessToken) return undefined;
    const plan = await fetchProductPlan(accessToken);
    setProduct(plan); onProduct?.(plan);
    return plan;
  }, [accessToken, onProduct]);

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    Promise.all([fetchProductPlan(accessToken), fetchBillingOffering(accessToken)])
      .then(async ([plan, offering]) => {
        if (!active) return;
        setProduct(plan); onProduct?.(plan);
        setServerOffering(offering);
        if (plan.billing?.period) setPeriod(plan.billing.period);
        if (availability.available && user?.id && !isAnonymous) {
          await identifyBillingUser(user.id);
          // Show ONLY the offering the server named (Founding 100 is decided server-side).
          const storeSide = await loadOffering(offering.offeringId);
          if (active) setStoreOffering(storeSide);
        }
      })
      .catch((cause: unknown) => { if (active) setError(plainError(cause, 'Plans did not load. Check your connection and try again.')); });
    return () => { active = false; };
  }, [accessToken, availability.available, isAnonymous, onProduct, user?.id, reloadKey]);

  const packagesById = useMemo(() => {
    const map: Record<string, PurchasesPackage> = {};
    for (const pkg of storeOffering?.availablePackages ?? []) map[pkg.identifier] = pkg;
    return map;
  }, [storeOffering]);
  const storePrices = useMemo(() => {
    const prices: Record<string, StorePrice> = {};
    for (const [id, pkg] of Object.entries(packagesById)) prices[id] = { priceString: pkg.product.priceString, introPriceString: pkg.product.introPrice?.priceString };
    return prices;
  }, [packagesById]);
  const founding = serverOffering?.founding === true || serverOffering?.offering === 'founding';
  const offers = tierOffers(period, founding, storePrices);
  const banner = offerBanner({ founding, spotsLeft: serverOffering?.spotsLeft ?? null });

  const entitlement = product?.entitlement;
  const billing = product?.billing ?? null;
  const usable = entitlement ? entitlement.status === 'active' || entitlement.status === 'trialing' : false;
  const currentPlan = usable ? entitlement?.plan ?? 'beta' : 'beta';
  // A subscription belongs to an account: an anonymous session saves the account first.
  const purchasesEnabled = availability.available && !isAnonymous && Boolean(privacyUrl) && Boolean(termsUrl) && Boolean(storeOffering);

  const confirmWithServer = async (before?: ProductPlanResponse) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await loadPlan();
      if (next && (next.entitlement.plan !== before?.entitlement.plan || next.entitlement.storeProductId !== before?.entitlement.storeProductId || next.entitlement.status !== before?.entitlement.status)) return true;
      await sleep(2000);
    }
    return false;
  };

  const purchase = async (plan: PaidPlan) => {
    const offer = offers.find((item) => item.plan === plan);
    const pkg = offer ? packagesById[offer.packageId] : undefined;
    if (!pkg || busy) return;
    setBusy(plan); setError(undefined); setNotice(undefined);
    try {
      const outcome = await buyPackage(pkg);
      if (outcome === 'cancelled') return;
      setNotice('Confirming with the store…');
      const confirmed = await confirmWithServer(product);
      setNotice(confirmed ? 'Your plan is updated.' : 'The store accepted the purchase. Your plan updates here as soon as the store confirms it.');
      onFinished?.('purchased');
    } catch (cause) {
      setError(plainError(cause, 'The purchase did not complete. You were not charged twice; try again.'));
    } finally { setBusy(undefined); }
  };

  const restore = async () => {
    if (busy || !availability.available) return;
    setBusy('restore'); setError(undefined); setNotice(undefined);
    try {
      await restoreStorePurchases();
      setNotice(await confirmWithServer(product) ? 'Purchases restored.' : 'Restore sent to the store. Any active subscription appears here once the store confirms it.');
    } catch (cause) {
      setError(plainError(cause, 'Restore did not finish. Try again.'));
    } finally { setBusy(undefined); }
  };

  const manage = async () => {
    const target = (availability.available ? await managementUrl() : undefined) ?? storeManageUrl(billing?.store ?? store ?? 'app_store');
    await openExternal({ kind: 'web', url: target });
  };

  const disclosureOffer = offers.find((item) => item.plan === (PLAN_RANK[currentPlan]! >= 1 ? currentPlan : 'chief_of_staff')) ?? offers[0]!;

  return (
    <View style={uiStyles.stack}>
      {error ? <Card tone="danger"><Body>{error}</Body><Button label="Try again" variant="secondary" onPress={() => { setError(undefined); setReloadKey((n) => n + 1); }} /></Card> : null}
      {notice ? <Card tone="muted"><Body>{notice}</Body></Card> : null}

      <OfferBannerCard banner={banner} />

      <TierGrid title={TIER_GRID_WHO.title} note={TIER_GRID_WHO.note} columns={TIER_GRID_WHO.columns} rows={TIER_GRID_WHO.rows} highlight={PAID_PLANS.indexOf(recommended)} />
      <TierGrid title={TIER_GRID_WHAT.title} columns={TIER_GRID_WHAT.columns} rows={TIER_GRID_WHAT.rows} highlight={PAID_PLANS.indexOf(recommended)} />
      <Body muted>{`${PLAN_SCREEN.annualLine} ${PLAN_SCREEN.autonomyLine}`}</Body>

      <SectionTitle>Choose your plan</SectionTitle>
      <ChoiceRow<BillingPeriod> options={[{ id: 'monthly', label: 'Monthly' }, { id: 'annual', label: 'Annual · 2 months free' }]} value={period} onChange={setPeriod} />
      {!availability.available ? <Card tone="muted"><Body>{UNAVAILABLE_COPY[availability.reason]}</Body></Card> : null}
      {availability.available && isAnonymous ? (
        <Card tone="warning">
          <AccountPanel title="Save your account first" sub="A subscription belongs to an account, so it is never tied to one phone. One tap, no password." onDone={() => setReloadKey((n) => n + 1)} />
        </Card>
      ) : null}
      {availability.available && (!privacyUrl || !termsUrl) ? <Card tone="muted"><Body>Purchases open once the Terms of Use and Privacy Policy links are configured for this build.</Body></Card> : null}
      {PAID_PLANS.map((planKey) => {
        const offer = offers.find((item) => item.plan === planKey)!;
        const card = product?.plans.find((plan) => plan.plan === planKey);
        const isCurrent = usable && currentPlan === planKey && (billing?.period ?? 'monthly') === period;
        const pkg = packagesById[offer.packageId];
        const action = PLAN_RANK[planKey]! > PLAN_RANK[currentPlan]! ? 'Upgrade to' : PLAN_RANK[planKey]! < PLAN_RANK[currentPlan]! ? 'Switch to' : billing ? 'Switch to' : 'Subscribe to';
        return (
          <Card key={planKey} tone={isCurrent || planKey === recommended ? 'accent' : 'default'}>
            <View style={uiStyles.row}>
              <CardTitle>{offer.displayName}</CardTitle>
              {isCurrent ? <Pill tone="success">Current</Pill> : planKey === recommended ? <Pill tone="success">{games.includes('parent') ? 'Most parents start here' : 'Recommended'}</Pill> : <Pill>{offer.tagline}</Pill>}
            </View>
            {card ? <Body>{card.promise}</Body> : null}
            <KeyValue label="Price" value={offer.priceLabel} />
            {offer.note ? <Body muted>{offer.note}</Body> : null}
            {card ? <KeyValue label="Autonomy ceiling" value={`${card.maxAutonomyLevel} · ${card.maxAutonomyLabel}`} /> : null}
            {!isCurrent ? (
              <Button label={busy === planKey ? 'Opening the store…' : `${action} ${offer.displayName} · ${offer.priceLabel}`} disabled={!purchasesEnabled || !pkg || Boolean(busy)} onPress={() => void purchase(planKey)} />
            ) : null}
          </Card>
        );
      })}

      {onboarding && CLOSED_BETA_BUILD ? (
        <Card tone="muted"><Body>{PLAN_SCREEN.betaLine}</Body><Button label="Start with the closed beta" variant="secondary" onPress={() => onFinished?.('beta')} /></Card>
      ) : null}
      {/* Never a dead end (docs/35 E6): whatever this build can or cannot buy, there is a way on.
          Today then shows "Pick a plan to start Day 1" instead of a check-in the server refuses. */}
      {onboarding && !CLOSED_BETA_BUILD ? (
        <Card tone="muted">
          <Body>{availability.available ? 'Not ready to choose? Your OS is installed and saved. Look around first; Today keeps the plans one tap away.' : `${UNAVAILABLE_COPY[availability.reason]} Your OS is installed and saved to your account.`}</Body>
          <Button label={availability.available ? 'Decide later, show me Today' : 'Go to Today'} variant="secondary" onPress={() => onFinished?.('continue')} />
        </Card>
      ) : null}

      <Card tone="muted">
        <Button label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'} variant="secondary" disabled={!availability.available || Boolean(busy)} onPress={() => void restore()} />
        <Button label="Manage subscription" variant="secondary" onPress={() => void manage()} />
      </Card>

      <SectionTitle>Subscription terms</SectionTitle>
      <Card tone="muted">
        {subscriptionDisclosure(billing?.store ?? store ?? 'app_store', disclosureOffer).map((line) => <Body key={line} muted>{line}</Body>)}
        <View style={uiStyles.row}>
          {termsUrl ? <Button label="Terms of Use" variant="secondary" onPress={() => void openExternal({ kind: 'web', url: termsUrl })} /> : null}
          {privacyUrl ? <Button label="Privacy Policy" variant="secondary" onPress={() => void openExternal({ kind: 'web', url: privacyUrl })} /> : null}
        </View>
      </Card>
    </View>
  );
}

/** The introductory offer, styled as a promotion: ribbon, struck list price, saving, scarcity (server number only). */
export function OfferBannerCard({ banner }: { banner: OfferBanner }) {
  return (
    <View style={styles.offer} accessible accessibilityRole="summary" accessibilityLabel={`${banner.headline}. ${banner.now} instead of ${banner.was}. ${banner.saving}. ${banner.explain}${banner.scarcity ? ` ${banner.scarcity}.` : ''}`}>
      <Text style={styles.ribbon}>{banner.ribbon}</Text>
      <Text style={styles.offerHeadline}>{banner.headline}</Text>
      <View style={styles.priceRow}>
        <Text style={styles.now}>{banner.now}</Text>
        <Text style={styles.instead}>instead of</Text>
        <Text style={styles.was}>{banner.was}</Text>
        <Text style={styles.save}>{banner.saving}</Text>
      </View>
      <Text style={styles.explain}>{banner.explain}</Text>
      {banner.scarcity ? <Text style={styles.scarcity}>{banner.scarcity}</Text> : null}
    </View>
  );
}

/** A tier grid: one card per row on a phone (no 4-column table at 390 pt, no sideways scroll). */
export function TierGrid({ title, note, columns, rows, highlight }: {
  title: string; note?: string; columns: readonly string[]; rows: ReadonlyArray<{ label: string; cells: readonly string[] }>; highlight?: number;
}) {
  return (
    <View style={uiStyles.stack}>
      <SectionTitle>{title}</SectionTitle>
      {note ? <Body muted>{note}</Body> : null}
      {rows.map((row) => (
        <Card key={row.label}>
          <CardTitle>{row.label}</CardTitle>
          {row.cells.map((cell, i) => (
            <View key={`${row.label}-${columns[i]}`} style={[styles.cell, i === highlight && styles.cellHighlight]}>
              <Text style={styles.cellHead}>{columns[i]}</Text>
              <Text style={styles.cellBody}>{cell}</Text>
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  offer: { backgroundColor: colors.warningSoft, borderColor: '#DFC49D', borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.xs },
  ribbon: { alignSelf: 'flex-start', backgroundColor: colors.warning, color: '#FFFFFF', fontWeight: '900', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  offerHeadline: { color: colors.ink, fontSize: 20, lineHeight: 26, fontWeight: '800' },
  priceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing.xs },
  now: { color: colors.ink, fontSize: 28, fontWeight: '900' },
  instead: { color: colors.inkMuted, fontSize: 14 },
  was: { color: colors.inkMuted, fontSize: 18, textDecorationLine: 'line-through' },
  save: { color: '#FFFFFF', backgroundColor: colors.success, fontWeight: '900', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  explain: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  scarcity: { color: colors.warning, fontWeight: '800', fontSize: 15 },
  cell: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.sm, gap: 2 },
  cellHighlight: { backgroundColor: colors.accentSoft },
  cellHead: { color: colors.inkMuted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  cellBody: { color: colors.ink, fontSize: 15, lineHeight: 21 },
});
