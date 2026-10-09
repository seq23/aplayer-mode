import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Body, Button, Card, ErrorState, LinkButton, LoadingState, Muted, Reason, Screen, TextField } from '../../src/components/ui';
import { attachPrecheckout, claimPrecheckout, fetchProductPlan, reconcileBilling } from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';
import { useConsent } from '../../src/state/consent';
import { useLifeGraph } from '../../src/state/lifeGraph';
import { hasDailyLoopAccess } from '../../src/billing/access';
import { webCheckoutAllowed } from '../../src/billing/distribution';
import { appDistribution } from '../../src/billing/purchases';
import { WEB_CHECKOUT_COPY } from '../../src/billing/webCheckout';
import { ATTACH_FINAL_ERRORS, PRECHECKOUT_COPY, RETURN_COPY, attachUntilDone, checkoutIdFromReturn, claimUntilPaid, clearPendingCheckout, payFirstAllowed, pendingCheckout, returnCheckout, type PendingCheckout } from '../../src/billing/precheckout';
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
 * setup questions start (health-data choice first when it is not made yet). When that email
 * ALREADY has an account (0096) the claim grants nothing: the 6-digit code signs them into that
 * account, and the signed-in session attaches the checkout (POST /v1/billing/precheckout/attach)
 * before the usual plan check below.
 */
export default function BillingReturn() {
  const { accessToken, status, user, isAnonymous, signOut } = useSession();
  const { ageConfirmed } = useConsent();
  const { refresh } = useLifeGraph();
  const [view, setView] = useState<'confirming' | 'pending' | 'otherAccount' | 'refused'>('confirming');
  const [refusal, setRefusal] = useState<string>();
  // "Check again" after the minute runs out: one more round of the same checks.
  const [round, setRound] = useState(0);
  const [pending, setPending] = useState<PendingCheckout>();
  // The code signed the buyer into an EXISTING account: attach `pending` instead of claiming it.
  const [attaching, setAttaching] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // An anonymous draft session is not an account: the buyer still claims with the email they paid with.
  const signedIn = Boolean(accessToken) && !isAnonymous;

  useEffect(() => {
    if (!webCheckoutAllowed(appDistribution())) { router.replace('/'); return; }
    if (status === 'loading') return;
    if (!signedIn || !accessToken) {
      if (attaching) return;
      // The id RevenueCat returned with (?app_user_id=) wins over this browser's stored one.
      const waiting = payFirstAllowed(appDistribution()) ? returnCheckout((globalThis as { location?: { search?: string } }).location?.search) : undefined;
      if (waiting) { setPending(waiting); return; }
      router.replace('/'); return;
    }
    // Signed in by the claim below: the payment is already applied, go to the questions.
    if (pending && user?.id === pending.id && !attaching) return;
    // Every account route is shut until the 18+ record is on the server (0093); ConsentGate asks
    // for it, or this device's earlier tap is sent a few seconds after sign-in. Attaching before
    // that got a 403 and lost the payment (9 Oct 2026), so nothing below runs until it is there.
    if (!ageConfirmed) return;
    let active = true;
    (async () => {
      setView('confirming'); setRefusal(undefined);
      // A pay-first checkout to attach to the signed-in account (the server re-checks everything,
      // the email above all): the one just claimed, else the id RevenueCat returned with, else
      // this browser's stored one. A different email is NEVER attached; the page says so.
      const payFirst = payFirstAllowed(appDistribution());
      const fromUrl = payFirst ? checkoutIdFromReturn((globalThis as { location?: { search?: string } }).location?.search) : undefined;
      const target = attaching ? pending?.id : (fromUrl ?? (payFirst ? pendingCheckout()?.id : undefined));
      const named = attaching || Boolean(fromUrl);
      if (target && target !== user?.id) {
        const result = await attachUntilDone(() => attachPrecheckout(target, accessToken), sleep, undefined, () => active);
        if (!active) return;
        if (result.attached) clearPendingCheckout();
        else if (ATTACH_FINAL_ERRORS.has(result.error)) {
          // A stale id this browser kept is simply dropped; one this visit named is explained.
          if (!named) clearPendingCheckout();
          else if (result.error === 'email_mismatch' && !attaching) { setView('otherAccount'); return; }
          else { setRefusal(result.message ?? PRECHECKOUT_COPY.unavailable); setView('refused'); return; }
        }
      }
      for (let attempt = 0; attempt < 15 && active; attempt += 1) {
        // Never rely on the webhook alone: ask the server to reconcile from RevenueCat now and then.
        if (RECONCILE_ATTEMPTS.has(attempt)) await reconcileBilling(accessToken).catch(() => undefined);
        const plan = await fetchProductPlan(accessToken).catch(() => undefined);
        if (plan && plan.entitlement.plan !== 'beta' && hasDailyLoopAccess(plan.entitlement)) {
          if (!active) return;
          await refresh().catch(() => undefined);
          router.replace('/(tabs)/today');
          return;
        }
        await sleep(2000);
      }
      if (active) setView('pending');
    })();
    return () => { active = false; };
  }, [accessToken, status, signedIn, pending, user?.id, attaching, ageConfirmed, round]);

  if (pending && !attaching) return <ClaimAccount pending={pending} onExistingAccount={() => setAttaching(true)} />;

  const leave = async () => {
    if (signingOut) return;
    setSigningOut(true);
    // Signed out, this page asks for the email the purchase was made with (the claim above).
    try { await signOut(); } catch { /* the session provider shows the error */ } finally { setSigningOut(false); }
  };

  return (
    <Screen title="Your plan">
      {view === 'confirming' ? (
        <Card tone="muted">
          <LoadingState label={WEB_CHECKOUT_COPY.confirming} />
          <Muted align="center">{RETURN_COPY.waitingHint}</Muted>
        </Card>
      ) : null}
      {view === 'pending' ? (
        <Card tone="muted">
          <Body>{RETURN_COPY.stillConfirming}</Body>
          <Button label={RETURN_COPY.checkAgain} icon="refresh-cw" onPress={() => setRound((n) => n + 1)} />
          <Button label="Go to Today" variant="secondary" onPress={() => router.replace('/(tabs)/today')} />
        </Card>
      ) : null}
      {view === 'otherAccount' ? (
        <Card tone="warning">
          <Body>{RETURN_COPY.otherAccount(user?.email ?? 'another account')}</Body>
          <Button label={signingOut ? 'Signing out…' : RETURN_COPY.signOut} busy={signingOut} onPress={() => void leave()} />
          <LinkButton label="Go to Today" onPress={() => router.replace('/(tabs)/today')} />
        </Card>
      ) : null}
      {view === 'refused' ? (
        <>
          <ErrorState message={refusal ?? PRECHECKOUT_COPY.unavailable} />
          <Button label="Go to Today" variant="secondary" onPress={() => router.replace('/(tabs)/today')} />
        </>
      ) : null}
    </Screen>
  );
}

/** Pay first, account after: the email typed at checkout, then its 6-digit code. */
function ClaimAccount({ pending, onExistingAccount }: { pending: PendingCheckout; onExistingAccount: () => void }) {
  const { sendEmailCode, verifyEmailCode } = useSession();
  const { healthDecision } = useConsent();
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [existingAccount, setExistingAccount] = useState(false);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const run = async (call: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await call(); } catch (cause) { setError(plainError(cause, 'That didn\'t work. Try again.')); } finally { setBusy(false); }
  };

  const claim = () => run(async () => {
    if (!validEmail) { setError('Enter a full email address.'); return; }
    // Right after paying RevenueCat may not have recorded it yet: re-ask quietly for about a minute.
    const result = await claimUntilPaid(() => claimPrecheckout({ checkoutId: pending.id, email: email.trim() }));
    if (!result.claimed) { setError(result.message ?? PRECHECKOUT_COPY.unavailable); return; }
    setExistingAccount(result.existingAccount === true);
    await sendEmailCode(email);
    setStage('code');
  });

  const verify = () => run(async () => {
    if (code.length !== 6) { setError('The code has 6 digits.'); return; }
    await verifyEmailCode(email, code, name);
    // An existing account: keep the checkout id; the signed-in page attaches it, then checks the plan.
    if (existingAccount) { onExistingAccount(); return; }
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
        ? <Button label={busy ? PRECHECKOUT_COPY.confirming : PRECHECKOUT_COPY.claim} icon="mail" busy={busy} onPress={() => void claim()} />
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
