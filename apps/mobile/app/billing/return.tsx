import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, LinkButton, Muted, Reason, Screen, TextField } from '../../src/components/ui';
import { claimPrecheckout, fetchProductPlan, reconcileBilling } from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';
import { useConsent } from '../../src/state/consent';
import { hasDailyLoopAccess } from '../../src/billing/access';
import { webCheckoutAllowed } from '../../src/billing/distribution';
import { appDistribution } from '../../src/billing/purchases';
import { WEB_CHECKOUT_COPY } from '../../src/billing/webCheckout';
import { PRECHECKOUT_COPY, clearPendingCheckout, payFirstAllowed, pendingCheckout, type PendingCheckout } from '../../src/billing/precheckout';
import { plainError } from '../../src/api/errors';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll attempts (2 s apart) that also ask the server to reconcile; within the API's 6-per-minute limit. */
export const RECONCILE_ATTEMPTS: ReadonlySet<number> = new Set([0, 2, 5, 9, 14]);

/**
 * Where RevenueCat Web Billing sends a card buyer back (WEB_BILLING_CONFIG.returnUrl,
 * app.aplayermode.com/billing/return). The payment reaches APM through the verified webhook
 * or, when that is late or missed, through the server's reconcile (it reads this account's
 * subscription from RevenueCat itself). This screen asks for both (briefly) and starts Day 1
 * the moment the plan is on. Store builds never reach it: they redirect home.
 *
 * Pay first (docs/33 §10): a buyer who came from "Join the Founding 100" has no account yet,
 * only this browser's checkout id. They type the email they paid with, the server creates the
 * account with id = checkout id and applies the payment, they type the 6-digit code, and the
 * setup questions start (health-data choice first when it is not made yet).
 */
export default function BillingReturn() {
  const { accessToken, status, user } = useSession();
  const [message, setMessage] = useState<string>(WEB_CHECKOUT_COPY.confirming);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState<PendingCheckout>();

  useEffect(() => {
    if (!webCheckoutAllowed(appDistribution())) { router.replace('/'); return; }
    if (status === 'loading') return;
    if (!accessToken) {
      const waiting = payFirstAllowed(appDistribution()) ? pendingCheckout() : undefined;
      if (waiting) { setPending(waiting); return; }
      router.replace('/'); return;
    }
    // Signed in by the claim below: the payment is already applied, go to the questions.
    if (pending && user?.id === pending.id) return;
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
  }, [accessToken, status, pending, user?.id]);

  if (pending) return <ClaimAccount pending={pending} />;

  return (
    <Screen title="Your plan">
      <Card tone="muted">
        <Body>{message}</Body>
        {done ? <Button label="Go to Today" variant="secondary" onPress={() => router.replace('/(tabs)/today')} /> : null}
      </Card>
    </Screen>
  );
}

/** Pay first, account after: the email typed at checkout, then its 6-digit code. */
function ClaimAccount({ pending }: { pending: PendingCheckout }) {
  const { sendEmailCode, verifyEmailCode } = useSession();
  const { healthDecision } = useConsent();
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const run = async (call: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await call(); } catch (cause) { setError(plainError(cause, 'That didn\'t work. Try again.')); } finally { setBusy(false); }
  };

  const claim = () => run(async () => {
    if (!validEmail) { setError('Enter a full email address.'); return; }
    const result = await claimPrecheckout({ checkoutId: pending.id, email: email.trim() });
    if (!result.claimed) { setError(result.message ?? PRECHECKOUT_COPY.unavailable); return; }
    await sendEmailCode(email);
    setStage('code');
  });

  const verify = () => run(async () => {
    if (code.length !== 6) { setError('The code has 6 digits.'); return; }
    await verifyEmailCode(email, code, name);
    clearPendingCheckout();
    router.replace(healthDecision ? '/intake' : '/health-consent');
  });

  return (
    <Screen title={stage === 'email' ? PRECHECKOUT_COPY.title : 'Check your email'}>
      <Body muted>{stage === 'email' ? PRECHECKOUT_COPY.lead : `We sent a 6-digit code to ${email.trim()}. Type it here.`}</Body>
      {stage === 'email' ? (
        <TextField accessibilityLabel="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" />
      ) : (
        <>
          <TextField code accessibilityLabel="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" />
          <TextField accessibilityLabel="First name" value={name} onChangeText={setName} autoComplete="given-name" textContentType="givenName" placeholder="First name" />
        </>
      )}
      {error ? <Reason>{error}</Reason> : null}
      {stage === 'email'
        ? <Button label={busy ? 'Checking your payment…' : PRECHECKOUT_COPY.claim} icon="mail" busy={busy} onPress={() => void claim()} />
        : (
          <>
            <Button label={busy ? 'Checking…' : 'Verify and start setup'} busy={busy} onPress={() => void verify()} />
            <LinkButton label="Resend the code" onPress={() => void run(() => sendEmailCode(email))} />
          </>
        )}
      <Muted>{PRECHECKOUT_COPY.footnote}</Muted>
    </Screen>
  );
}
