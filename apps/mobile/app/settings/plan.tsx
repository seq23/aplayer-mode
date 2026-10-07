import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import type { BillingPeriod, PaidPlan } from '@apm/policy';
import { Body, Button, Card, CardTitle, ChoiceRow, KeyValue, Pill, Screen, SectionTitle, uiStyles } from '../../src/components/ui';
import {
  fetchBillingOffering,
  fetchHouseholdInterest,
  fetchProductPlan,
  setHouseholdInterest,
  type BillingOfferingResponse,
  type ProductPlanResponse,
} from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';
import { APPLE_STANDARD_EULA_URL, PAID_PLANS, storeManageUrl, subscriptionDisclosure, tierOffers, type StorePrice } from '../../src/billing/catalog';
import {
  UNAVAILABLE_COPY,
  billingAvailability,
  buyPackage,
  identifyBillingUser,
  legalUrls,
  loadOffering,
  managementUrl,
  restoreStorePurchases,
} from '../../src/billing/purchases';

const PLAN_RANK: Record<string, number> = { beta: 0, chief_of_staff: 1, life_os: 2, autopilot: 3, household: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function PlanScreen() {
  const { accessToken, user } = useSession();
  const availability = useMemo(() => billingAvailability(), []);
  const store = availability.available ? availability.store : undefined;
  const { termsUrl, privacyUrl } = legalUrls(store, APPLE_STANDARD_EULA_URL);
  const [product, setProduct] = useState<ProductPlanResponse>();
  const [serverOffering, setServerOffering] = useState<BillingOfferingResponse>();
  const [storeOffering, setStoreOffering] = useState<PurchasesOffering>();
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [householdInterested, setHouseholdInterestedState] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const loadPlan = useCallback(async () => {
    if (!accessToken) return undefined;
    const plan = await fetchProductPlan(accessToken);
    setProduct(plan);
    return plan;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    Promise.all([fetchProductPlan(accessToken), fetchHouseholdInterest(accessToken), fetchBillingOffering(accessToken)])
      .then(async ([plan, interest, offering]) => {
        if (!active) return;
        setProduct(plan);
        setHouseholdInterestedState(interest.interested);
        setServerOffering(offering);
        if (plan.billing?.period) setPeriod(plan.billing.period);
        if (availability.available && user?.id) {
          await identifyBillingUser(user.id);
          // Show ONLY the offering the server named (Founding 100 is decided server-side).
          const storeSide = await loadOffering(offering.offeringId);
          if (active) setStoreOffering(storeSide);
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Unable to load your plan.');
      });
    return () => { active = false; };
  }, [accessToken, availability.available, user?.id]);

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
  const offers = tierOffers(period, serverOffering?.founding === true || serverOffering?.offering === 'founding', storePrices);

  const entitlement = product?.entitlement;
  const billing = product?.billing ?? null;
  const usable = entitlement ? entitlement.status === 'active' || entitlement.status === 'trialing' : false;
  const currentPlan = usable ? entitlement?.plan ?? 'beta' : 'beta';
  const purchasesEnabled = availability.available && Boolean(privacyUrl) && Boolean(termsUrl) && Boolean(storeOffering);

  // The webhook, not the SDK, changes the plan: re-read the server until it reflects the purchase.
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
      setNotice(await confirmWithServer(product) ? 'Your plan is updated.' : 'The store accepted the purchase. Your plan updates here as soon as the store confirms it.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The purchase did not complete.');
    } finally {
      setBusy(undefined);
    }
  };

  const restore = async () => {
    if (busy || !availability.available) return;
    setBusy('restore'); setError(undefined); setNotice(undefined);
    try {
      await restoreStorePurchases();
      setNotice(await confirmWithServer(product) ? 'Purchases restored.' : 'Restore sent to the store. Any active subscription appears here once the store confirms it.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to restore purchases.');
    } finally {
      setBusy(undefined);
    }
  };

  const manage = async () => {
    const target = (availability.available ? await managementUrl() : undefined)
      ?? storeManageUrl(billing?.store ?? store ?? 'app_store');
    await Linking.openURL(target);
  };

  const changeHouseholdInterest = async () => {
    if (!accessToken || busy) return;
    setBusy('household');
    setError(undefined);
    try {
      const next = !householdInterested;
      const result = await setHouseholdInterest(next, accessToken);
      setHouseholdInterestedState(result.interested);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update Household interest.');
    } finally {
      setBusy(undefined);
    }
  };

  const disclosureOffer = offers.find((item) => item.plan === (PLAN_RANK[currentPlan]! >= 1 ? currentPlan : 'chief_of_staff')) ?? offers[0]!;

  return (
    <Screen
      eyebrow="Your plan"
      title="Choose how much responsibility APM carries."
      subtitle="One A Player Mode. Three individual service levels. Upgrading makes capability available; it never grants action permission by itself."
    >
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      {notice ? <Card tone="muted"><Body>{notice}</Body></Card> : null}

      <Card tone="accent">
        <CardTitle>{entitlement?.displayName ?? 'Loading your plan…'}</CardTitle>
        {entitlement ? (
          <>
            <KeyValue label="Status" value={entitlement.status} />
            {billing ? (
              <>
                <KeyValue label="Billing" value={`${billing.period === 'annual' ? 'Annual' : 'Monthly'} · ${billing.store === 'app_store' ? 'App Store' : 'Google Play'}${billing.founding ? ' · Founding 100' : ''}`} />
                <KeyValue label={billing.renews ? 'Renews' : 'Access until'} value={formatDate(billing.periodEnd)} />
                {billing.cancelAtPeriodEnd ? <Body muted>Auto-renew is off. You keep access until the end of the period you paid for.</Body> : null}
                {billing.billingIssue ? <Body>The store could not renew your subscription. Update your payment method in {billing.store === 'app_store' ? 'your App Store account' : 'Google Play'} to keep access.</Body> : null}
                {billing.pendingPlan ? <Body muted>Changes to {product?.plans.find((plan) => plan.plan === billing.pendingPlan)?.displayName ?? billing.pendingPlan} at your next renewal.</Body> : null}
              </>
            ) : null}
            <KeyValue label="Maximum autonomy" value={`${entitlement.maxAutonomyLevel} · ${entitlement.maxAutonomyLabel}`} />
            <Body muted>{entitlement.promise}</Body>
          </>
        ) : null}
      </Card>

      <SectionTitle>Individual plans</SectionTitle>
      <ChoiceRow<BillingPeriod>
        options={[{ id: 'monthly', label: 'Monthly' }, { id: 'annual', label: 'Annual · 2 months free' }]}
        value={period}
        onChange={setPeriod}
      />
      {!availability.available ? <Card tone="muted"><Body>{UNAVAILABLE_COPY[availability.reason]}</Body></Card> : null}
      {availability.available && (!privacyUrl || !termsUrl) ? <Card tone="muted"><Body>Purchases open once the Terms of Use and Privacy Policy links are configured for this build.</Body></Card> : null}
      <View style={uiStyles.stack}>
        {PAID_PLANS.map((planKey) => {
          const offer = offers.find((item) => item.plan === planKey)!;
          const card = product?.plans.find((plan) => plan.plan === planKey);
          const isCurrent = usable && currentPlan === planKey && (billing?.period ?? 'monthly') === period;
          const pkg = packagesById[offer.packageId];
          const action = PLAN_RANK[planKey]! > PLAN_RANK[currentPlan]! ? 'Upgrade to' : PLAN_RANK[planKey]! < PLAN_RANK[currentPlan]! ? 'Switch to' : billing ? 'Switch to' : 'Subscribe to';
          return (
            <Card key={planKey} tone={isCurrent ? 'accent' : 'default'}>
              <View style={uiStyles.row}>
                <CardTitle>{offer.displayName}</CardTitle>
                {isCurrent ? <Pill tone="success">Current</Pill> : offer.founding ? <Pill tone="warning">Founding 100</Pill> : <Pill>{offer.tagline}</Pill>}
              </View>
              {card ? <Body>{card.promise}</Body> : null}
              <KeyValue label="Price" value={offer.priceLabel} />
              {offer.note ? <Body muted>{offer.note}</Body> : null}
              {card ? <KeyValue label="Autonomy ceiling" value={`${card.maxAutonomyLevel} · ${card.maxAutonomyLabel}`} /> : null}
              {card?.highlights.map((highlight) => <Body key={highlight} muted>• {highlight}</Body>)}
              {!isCurrent ? (
                <Button
                  label={busy === planKey ? 'Opening the store…' : `${action} ${offer.displayName} · ${offer.priceLabel}`}
                  disabled={!purchasesEnabled || !pkg || Boolean(busy)}
                  onPress={() => void purchase(planKey)}
                />
              ) : null}
            </Card>
          );
        })}
      </View>

      <Card tone="muted">
        <Button label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'} variant="secondary" disabled={!availability.available || Boolean(busy)} onPress={() => void restore()} />
        <Button label="Manage subscription" variant="secondary" onPress={() => void manage()} />
      </Card>

      <SectionTitle>Subscription terms</SectionTitle>
      <Card tone="muted">
        {subscriptionDisclosure(billing?.store ?? store ?? 'app_store', disclosureOffer).map((line) => <Body key={line} muted>{line}</Body>)}
        <View style={uiStyles.row}>
          {termsUrl ? <Button label="Terms of Use" variant="secondary" onPress={() => void Linking.openURL(termsUrl)} /> : null}
          {privacyUrl ? <Button label="Privacy Policy" variant="secondary" onPress={() => void Linking.openURL(privacyUrl)} /> : null}
        </View>
      </Card>

      <SectionTitle>Household</SectionTitle>
      <Card tone="muted">
        <View style={uiStyles.row}>
          <CardTitle>Household OS</CardTitle>
          <Pill tone="warning">Later</Pill>
        </View>
        <Body>Coordinate shared calendars, responsibilities and mental load across a household. We are not activating Household yet.</Body>
        <Body muted>Your interest helps determine when we build the collaborative product. Joining this list grants no Household access or authority.</Body>
        <Button
          label={busy === 'household' ? 'Saving…' : householdInterested ? 'Remove me from Household interest list' : 'I’m interested in Household OS'}
          variant="secondary"
          onPress={() => void changeHouseholdInterest()}
        />
      </Card>
    </Screen>
  );
}
