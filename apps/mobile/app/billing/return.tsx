import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, Screen } from '../../src/components/ui';
import { fetchProductPlan, reconcileBilling } from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';
import { hasDailyLoopAccess } from '../../src/billing/access';
import { webCheckoutAllowed } from '../../src/billing/distribution';
import { appDistribution } from '../../src/billing/purchases';
import { WEB_CHECKOUT_COPY } from '../../src/billing/webCheckout';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll attempts (2 s apart) that also ask the server to reconcile; within the API's 6-per-minute limit. */
export const RECONCILE_ATTEMPTS: ReadonlySet<number> = new Set([0, 2, 5, 9, 14]);

/**
 * Where RevenueCat Web Billing sends a card buyer back (WEB_BILLING_CONFIG.returnUrl,
 * app.aplayermode.com/billing/return). The payment reaches APM through the verified webhook
 * or, when that is late or missed, through the server's reconcile (it reads this account's
 * subscription from RevenueCat itself). This screen asks for both (briefly) and starts Day 1
 * the moment the plan is on. Store builds never reach it: they redirect home.
 */
export default function BillingReturn() {
  const { accessToken, status } = useSession();
  const [message, setMessage] = useState<string>(WEB_CHECKOUT_COPY.confirming);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!webCheckoutAllowed(appDistribution())) { router.replace('/'); return; }
    if (status === 'loading') return;
    if (!accessToken) { router.replace('/'); return; }
    let active = true;
    (async () => {
      for (let attempt = 0; attempt < 15 && active; attempt += 1) {
        // Never rely on the webhook alone: ask the server to reconcile from RevenueCat now and then.
        if (RECONCILE_ATTEMPTS.has(attempt)) await reconcileBilling(accessToken).catch(() => undefined);
        const plan = await fetchProductPlan(accessToken).catch(() => undefined);
        if (plan && plan.entitlement.plan !== 'beta' && hasDailyLoopAccess(plan.entitlement)) {
          if (!active) return;
          setMessage(WEB_CHECKOUT_COPY.confirmed);
          router.replace('/(tabs)/today');
          return;
        }
        await sleep(2000);
      }
      if (active) { setMessage(WEB_CHECKOUT_COPY.pending); setDone(true); }
    })();
    return () => { active = false; };
  }, [accessToken, status]);

  return (
    <Screen title="Your plan">
      <Card tone="muted">
        <Body>{message}</Body>
        {done ? <Button label="Go to Today" variant="secondary" onPress={() => router.replace('/(tabs)/today')} /> : null}
      </Card>
    </Screen>
  );
}
