import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { useSession, type AccountProvider, type AccountResult } from '../../state/session';
import { Body, Button, Card, CardTitle, LinkButton, Muted, QuestionTitle, Reason, Row, TextField } from '../ui';
import { radius, tap, useTheme } from '../../theme';
import { intakeStyles } from './primitives';
import { plainError } from '../../api/errors';
import { PREVIEW, PREVIEW_COPY } from '../../preview/flag';
import { codeBoxFor } from './codeBox';
import { signInOptions } from '../../auth/signInOptions';

/**
 * "Save your plan" (docs/34 §5): Apple (iOS only, first and at least as prominent as
 * Google; Guideline 4.8), Google (only while GOOGLE_SIGN_IN_ENABLED, src/auth/signInOptions.ts),
 * or a 6-digit email code typed in the same screen. No
 * passwords, no leaving the app to confirm an email, no vendor names in the copy.
 */
export function AccountPanel({ title, sub, onDone, onLater, laterLabel = 'Back' }: {
  title: string;
  sub: string;
  onDone: (result: AccountResult) => void;
  onLater?: () => void;
  laterLabel?: string;
}) {
  const { signInWithApple, signInWithGoogle, sendEmailCode, verifyEmailCode } = useSession();
  const [stage, setStage] = useState<'choose' | 'email' | 'code'>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [review, setReview] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<AccountProvider | 'send'>();
  const [error, setError] = useState<string>();
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Each tap is one run; a run that was already released (sheet cancelled) never clears a newer one.
  const runId = useRef(0);
  const run = async (provider: AccountProvider | 'send', call: (release: () => void) => Promise<AccountResult | void>) => {
    if (busy) return;
    const id = ++runId.current;
    const release = () => { if (runId.current === id) { runId.current += 1; setBusy(undefined); } };
    setBusy(provider); setError(undefined);
    try {
      const result = await call(release);
      if (result && result.outcome !== 'cancelled') onDone(result);
    } catch (cause) {
      if (runId.current === id) setError(plainError(cause, 'That didn\'t work. Try again.'));
    } finally { release(); }
  };

  const options = signInOptions(Platform.OS);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const box = codeBoxFor(review);
  if (stage === 'email' || stage === 'code') {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={intakeStyles.stack}>
        <QuestionTitle>{stage === 'email' ? 'Your email' : box.title}</QuestionTitle>
        <Body muted>{stage === 'email' ? 'We\'ll send a 6-digit code. You type it here; you never leave the app.' : box.lead(email)}</Body>
        {stage === 'email' ? (
          <TextField accessibilityLabel="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" />
        ) : (
          <>
            <TextField code={!review} accessibilityLabel={box.label} value={code} onChangeText={(t) => setCode(box.clean(t))} keyboardType={box.keyboardType} autoCapitalize="none" autoCorrect={false} textContentType={review ? 'none' : 'oneTimeCode'} autoComplete={review ? 'off' : 'one-time-code'} maxLength={box.maxLength} placeholder={box.label} />
            <TextField accessibilityLabel="First name" value={name} onChangeText={setName} autoComplete="given-name" textContentType="givenName" placeholder="First name" />
          </>
        )}
        {error ? <Reason>{error}</Reason> : null}
        {stage === 'email' ? (
          <Button label={busy === 'send' ? 'Sending…' : 'Email me a 6-digit code'} icon="mail" onPress={() => { if (validEmail) void run('send', async () => { setReview((await sendEmailCode(email)).review); setStage('code'); setResendIn(30); }); else setError('Enter a full email address.'); }} />
        ) : (
          <>
            <Button label={busy === 'email' ? 'Checking…' : 'Verify and continue'} onPress={() => { if (box.ready(code)) void run('email', () => verifyEmailCode(email, code, name)); else setError(box.notReady); }} />
            <Row justify="space-between" wrap gap="sm">
              <LinkButton disabled={resendIn > 0} label={resendIn > 0 ? `Resend in ${resendIn} s` : 'Resend the code'} onPress={() => void run('send', async () => { setReview((await sendEmailCode(email)).review); setResendIn(30); })} />
              <LinkButton label="Use a different email" onPress={() => { setStage('email'); setCode(''); setReview(false); }} />
            </Row>
          </>
        )}
        <LinkButton label="Back to the options" muted onPress={() => { setStage('choose'); setError(undefined); }} />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={intakeStyles.stack}>
      <QuestionTitle>{title}</QuestionTitle>
      <Body muted>{sub}</Body>
      {PREVIEW ? <Reason>{PREVIEW_COPY.signIn}</Reason> : null}
      {options.includes('apple') ? <AppleButton busy={busy === 'apple'} onPress={() => void run('apple', signInWithApple)} /> : null}
      {options.includes('google') ? <Button label={busy === 'google' ? 'Opening Google…' : 'Continue with Google'} variant="secondary" large onPress={() => void run('google', (release) => signInWithGoogle({ onSheetClosed: release }))} /> : null}
      {/* Alone (web, Android) the email code is the main button, not a secondary one. */}
      <Button label="Email me a 6-digit code" variant={options.length === 1 ? 'primary' : 'secondary'} icon="mail" large onPress={() => setStage('email')} />
      {onLater ? <Button label={laterLabel} variant="ghost" onPress={onLater} /> : null}
      {error ? <Reason>{error}</Reason> : null}
      <Card tone="muted">
        <CardTitle>Your account keeps your plan private and safe.</CardTitle>
        <Muted>No passwords. Private-life AI uses zero-retention, no-training routes only.</Muted>
        <LinkButton role="link" label="How APM protects your data" onPress={() => router.push('/settings/privacy')} />
      </Card>
    </View>
  );
}

/** The system Apple button (iOS only); the module is required lazily so web/Android never load it. */
function AppleButton({ onPress, busy }: { onPress: () => void; busy: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Apple = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  const { scheme } = useTheme();
  return (
    <View accessibilityLabel="Continue with Apple" style={{ opacity: busy ? 0.5 : 1 }}>
      <Apple.AppleAuthenticationButton
        buttonType={Apple.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={scheme === 'dark' ? Apple.AppleAuthenticationButtonStyle.WHITE : Apple.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={radius.pill}
        style={{ width: '100%', height: tap.primary }}
        onPress={onPress}
      />
    </View>
  );
}
