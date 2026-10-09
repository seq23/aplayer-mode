import { useCallback, useState } from 'react';
import { Body, Card, CardTitle, KeyValue, Screen } from '../../src/components/ui';
import { type ProductPlanResponse } from '../../src/api/apmApi';
import { PlanChoice } from '../../src/billing/PlanChoice';
import { PLAN_SCREEN } from '../../src/content/sell';
import { PLAN_STATUS_WORDS as STATUS_WORDS } from '../../src/billing/planSummary';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Settings → Your plan: the current plan and the shared plan choice (src/billing/PlanChoice). No placeholder products (App Review 2.1). */
export default function PlanScreen() {
  const [product, setProduct] = useState<ProductPlanResponse>();
  const onProduct = useCallback((next: ProductPlanResponse) => setProduct(next), []);

  const entitlement = product?.entitlement;
  const billing = product?.billing ?? null;

  return (
    <Screen title={PLAN_SCREEN.title} subtitle={PLAN_SCREEN.plate}>
      <Card tone="accent">
        <CardTitle>{entitlement?.displayName ?? 'Loading your plan…'}</CardTitle>
        {entitlement ? (
          <>
            <KeyValue label="Status" value={STATUS_WORDS[entitlement.status] ?? 'Not active'} />
            {billing ? (
              <>
                <KeyValue label="Billing" value={`${billing.period === 'annual' ? 'Annual' : 'Monthly'} · ${billing.store === 'app_store' ? 'App Store' : billing.store === 'google_play' ? 'Google Play' : 'Card'}${billing.founding ? ' · Founding Member price' : ''}`} />
                <KeyValue label={billing.renews ? 'Renews' : 'Access until'} value={formatDate(billing.periodEnd)} />
                {billing.cancelAtPeriodEnd ? <Body muted>Auto-renew is off. You keep access until the end of the period you paid for.</Body> : null}
                {billing.billingIssue ? <Body>The payment could not renew your subscription. Update your payment method in {billing.store === 'app_store' ? 'your App Store account' : billing.store === 'google_play' ? 'Google Play' : 'Manage subscription'} to keep access.</Body> : null}
                {billing.pendingPlan ? <Body muted>Changes to {product?.plans.find((plan) => plan.plan === billing.pendingPlan)?.displayName ?? billing.pendingPlan} at your next renewal.</Body> : null}
              </>
            ) : null}
            <KeyValue label="The most APM may do on its own" value={entitlement.maxAutonomyLabel} />
            <Body muted>{entitlement.promise}</Body>
          </>
        ) : null}
      </Card>

      <PlanChoice onProduct={onProduct} />

    </Screen>
  );
}
