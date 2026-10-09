import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Card, LoadingState, Screen } from '../src/components/ui';
import { fetchBillingOffering } from '../src/api/apmApi';
import { useSession } from '../src/state/session';
import { useConsent } from '../src/state/consent';
import { appDistribution } from '../src/billing/purchases';
import { FOUNDING_PACKAGE_ID, foundingCheckoutUrl, payFirstAllowed, pendingCheckout } from '../src/billing/precheckout';
import { WEB_CHECKOUT_COPY, WEB_PURCHASE_LINKS, webCheckoutFor } from '../src/billing/webCheckout';

/**
 * "Join the Founding 100" (aplayermode.com links here; the welcome page too): straight to the
 * Founding 100 card checkout, BEFORE the setup questions (docs/33 §10). 18+ comes first (one tap,
 * the same gate as Start). Signed in: the server's offering and the account id, as on the
 * paywall. Not signed in: a checkout id minted in this browser, claimed for a new account on
 * /billing/return. Web app only; any other build goes home.
 */
export default function JoinScreen() {
  const { status, accessToken, user, isAnonymous } = useSession();
  const { ageConfirmed } = useConsent();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!payFirstAllowed(appDistribution())) { router.replace('/'); return; }
    if (status === 'loading') return;
    if (!ageConfirmed) { router.replace({ pathname: '/age', params: { next: 'join' } }); return; }
    let active = true;
    (async () => {
      let url: string | undefined;
      if (accessToken && user?.id && !isAnonymous) {
        const offering = await fetchBillingOffering(accessToken).catch(() => undefined);
        const checkout = webCheckoutFor('web', Boolean(offering?.founding));
        url = checkout.kind === 'ready' ? checkout.urlFor(FOUNDING_PACKAGE_ID, user.id) : undefined;
      } else {
        const pending = pendingCheckout(Date.now(), true);
        url = pending ? foundingCheckoutUrl(pending.id, WEB_PURCHASE_LINKS.founding) : undefined;
      }
      if (!active) return;
      if (url && typeof window !== 'undefined') window.location.assign(url);
      else setMessage(WEB_CHECKOUT_COPY.notConfigured);
    })();
    return () => { active = false; };
  }, [status, accessToken, user?.id, isAnonymous, ageConfirmed]);

  return (
    <Screen fullBleed eyebrow="Founding 100" title="Opening the secure card checkout…">
      {message ? <Card tone="muted"><Body>{message}</Body></Card> : <LoadingState label="Opening the card checkout" />}
    </Screen>
  );
}
