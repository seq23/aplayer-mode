import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Card, CardTitle, KeyValue, Pill, Screen, SectionTitle, uiStyles } from '../../src/components/ui';
import { fetchHouseholdInterest, setHouseholdInterest, type ProductPlanResponse } from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';
import { PlanChoice } from '../../src/billing/PlanChoice';
import { PLAN_SCREEN } from '../../src/content/sell';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Settings → Your plan: the current plan, the shared plan choice (src/billing/PlanChoice), Household interest. */
export default function PlanScreen() {
  const { accessToken } = useSession();
  const [product, setProduct] = useState<ProductPlanResponse>();
  const [householdInterested, setHouseholdInterestedState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    fetchHouseholdInterest(accessToken).then((interest) => { if (active) setHouseholdInterestedState(interest.interested); }).catch(() => undefined);
    return () => { active = false; };
  }, [accessToken]);
  const onProduct = useCallback((next: ProductPlanResponse) => setProduct(next), []);

  const entitlement = product?.entitlement;
  const billing = product?.billing ?? null;

  const changeHouseholdInterest = async () => {
    if (!accessToken || busy) return;
    setBusy(true); setError(undefined);
    try {
      const result = await setHouseholdInterest(!householdInterested, accessToken);
      setHouseholdInterestedState(result.interested);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update Household interest.');
    } finally { setBusy(false); }
  };

  return (
    <Screen eyebrow="Your plan" title={PLAN_SCREEN.title} subtitle={PLAN_SCREEN.plate}>
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}
      <Card tone="accent">
        <CardTitle>{entitlement?.displayName ?? 'Loading your plan…'}</CardTitle>
        {entitlement ? (
          <>
            <KeyValue label="Status" value={entitlement.status} />
            {billing ? (
              <>
                <KeyValue label="Billing" value={`${billing.period === 'annual' ? 'Annual' : 'Monthly'} · ${billing.store === 'app_store' ? 'App Store' : 'Google Play'}${billing.founding ? ' · Founding Member price' : ''}`} />
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

      <PlanChoice onProduct={onProduct} />

      <SectionTitle>Household</SectionTitle>
      <Card tone="muted">
        <View style={uiStyles.row}>
          <CardTitle>Household OS</CardTitle>
          <Pill tone="warning">Later</Pill>
        </View>
        <Body>Coordinate shared calendars, responsibilities and mental load across a household. We are not activating Household yet.</Body>
        <Body muted>Your interest helps determine when we build the collaborative product. Joining this list grants no Household access or authority.</Body>
        <Button label={busy ? 'Saving…' : householdInterested ? 'Remove me from Household interest list' : 'I’m interested in Household OS'} variant="secondary" onPress={() => void changeHouseholdInterest()} />
      </Card>
    </Screen>
  );
}
