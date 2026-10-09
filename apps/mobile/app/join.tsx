import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, LoadingState, Screen } from '../src/components/ui';
import { fetchBillingOffering, fetchFoundingPlaces } from '../src/api/apmApi';
import { useSession } from '../src/state/session';
import { useConsent } from '../src/state/consent';
import { appDistribution } from '../src/billing/purchases';
import { FOUNDING_PACKAGE_ID, JOIN_COPY, STANDARD_PACKAGE_ID, foundingCheckoutUrl, joinOfferFor, payFirstAllowed, pendingCheckout, standardCheckoutUrl, type JoinOffer } from '../src/billing/precheckout';
import { WEB_CHECKOUT_COPY, WEB_PURCHASE_LINKS, webCheckoutFor } from '../src/billing/webCheckout';

/**
 * "Join the Founding 100" (aplayermode.com links here; the welcome page too): straight to the
 * Founding 100 card checkout, BEFORE the setup questions (docs/33 §10). 18+ comes first (one tap,
 * the same gate as Start). Signed in: the server's offering and the account id, as on the
 * paywall. Not signed in: a checkout id minted in this browser, claimed for a new account on
 * /billing/return. Web app only; any other build goes home.
 *
 * The founding price is sold ONLY while the server says places remain (9 Oct 2026): signed in,
 * the server's offering decides; otherwise the public count (GET /v1/billing/founding). Once the
 * Founding 100 is full the page says so and offers the standard Executive Roundtable checkout at
 * its normal price; when the count cannot be read it opens no checkout and offers Try again.
 */
export default function JoinScreen() {
  const { status, accessToken, user, isAnonymous } = useSession();
  const { ageConfirmed } = useConsent();
  const [message, setMessage] = useState<string>();
  const [offer, setOffer] = useState<JoinOffer>();
  const [standardUrl, setStandardUrl] = useState<string>();
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!payFirstAllowed(appDistribution())) { router.replace('/'); return; }
    if (status === 'loading') return;
    if (!ageConfirmed) { router.replace({ pathname: '/age', params: { next: 'join' } }); return; }
    let active = true;
    setOffer(undefined); setMessage(undefined); setStandardUrl(undefined);
    (async () => {
      let decided: JoinOffer;
      let url: string | undefined;
      if (accessToken && user?.id && !isAnonymous) {
        const offering = await fetchBillingOffering(accessToken).catch(() => undefined);
        decided = !offering ? 'unknown' : offering.offering === 'founding' ? 'founding' : 'standard';
        const checkout = webCheckoutFor('web', decided === 'founding');
        url = decided !== 'unknown' && checkout.kind === 'ready' ? checkout.urlFor(decided === 'founding' ? FOUNDING_PACKAGE_ID : STANDARD_PACKAGE_ID, user.id) : undefined;
      } else {
        decided = joinOfferFor(await fetchFoundingPlaces());
        const pending = decided === 'unknown' ? undefined : pendingCheckout(Date.now(), true);
        url = !pending ? undefined
          : decided === 'founding' ? foundingCheckoutUrl(pending.id, WEB_PURCHASE_LINKS.founding)
          : standardCheckoutUrl(pending.id, WEB_PURCHASE_LINKS.default);
      }
      if (!active) return;
      setOffer(decided);
      if (decided === 'unknown') { setMessage(JOIN_COPY.unknown); return; }
      if (!url) { setMessage(WEB_CHECKOUT_COPY.notConfigured); return; }
      // Founding: straight to the checkout. Full: say so first, then the standard checkout on a tap.
      if (decided === 'founding') { if (typeof window !== 'undefined') window.location.assign(url); return; }
      setStandardUrl(url);
    })();
    return () => { active = false; };
  }, [status, accessToken, user?.id, isAnonymous, ageConfirmed, round]);

  if (offer === 'standard') {
    return (
      <Screen fullBleed eyebrow={JOIN_COPY.fullEyebrow} title={JOIN_COPY.fullTitle}>
        <Card><Body>{JOIN_COPY.fullBody}</Body></Card>
        {standardUrl
          ? <Button label={JOIN_COPY.fullButton} large onPress={() => { if (typeof window !== 'undefined') window.location.assign(standardUrl); }} />
          : message ? <Card tone="muted"><Body>{message}</Body></Card> : null}
      </Screen>
    );
  }
  return (
    <Screen fullBleed eyebrow="Founding 100" title={JOIN_COPY.foundingTitle}>
      {message ? <Card tone="muted"><Body>{message}</Body></Card> : <LoadingState label="Opening the card checkout" />}
      {offer === 'unknown' ? <Button label={JOIN_COPY.tryAgain} icon="refresh-cw" onPress={() => setRound((n) => n + 1)} /> : null}
    </Screen>
  );
}
