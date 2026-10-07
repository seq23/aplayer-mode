import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { useSession, type AccountProvider, type AccountResult } from '../../state/session';
import { Body, Button, Card, CardTitle, LinkButton, Muted, QuestionTitle, Reason, Row, TextField } from '../ui';
import { radius, tap, useTheme } from '../../theme';
import { intakeStyles } from './primitives';

/**
 * "Save your plan" (docs/34 §5): Apple (iOS only, first and at least as prominent as
 * Google; Guideline 4.8), Google, or a 6-digit email code typed in the same screen. No
 * passwords, no leaving the app to confirm an email, no vendor names in the copy.
 */
export function AccountPanel({ title, sub, answeredCount, onDone, onLater, laterLabel = 'Not now, keep going' }: {
  title: string;
  sub: string;
  answeredCount?: number;
  onDone: (result: AccountResult) => void;
  onLater?: () => void;
  laterLabel?: string;
}) {
  const { signInWithApple, signInWithGoogle, sendEmailCode, verifyEmailCode } = useSession();
  const [stage, setStage] = useState<'choose' | 'email' | 'code'>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<AccountProvider | 'send'>();
  const [error, setError] = useState<string>();
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const run = async (provider: AccountProvider | 'send', call: () => Promise<AccountResult | void>) => {
    if (busy) return;
    setBusy(provider); setError(undefined);
    try {
      const result = await call();
      if (result && result.outcome !== 'cancelled') onDone(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That didn\'t work. Try again.');
    } finally { setBusy(undefined); }
  };

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (stage === 'email' || stage === 'code') {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={intakeStyles.stack}>
        <QuestionTitle>{stage === 'email' ? 'Your email' : 'Check your email'}</QuestionTitle>
        <Body muted>{stage === 'email' ? 'We\'ll send a 6-digit code. You type it here; you never leave the app.' : `We sent a 6-digit code to ${email.trim()}. Type it here.`}</Body>
        {stage === 'email' ? (
          <TextField accessibilityLabel="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" />
        ) : (
          <>
            <TextField code accessibilityLabel="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" />
            <TextField accessibilityLabel="First name" value={name} onChangeText={setName} autoComplete="given-name" textContentType="givenName" placeholder="First name" />
          </>
        )}
        {error ? <Reason>{error}</Reason> : null}
        {stage === 'email' ? (
          <Button label={busy === 'send' ? 'Sending…' : 'Email me a 6-digit code'} icon="mail" onPress={() => { if (validEmail) void run('send', async () => { await sendEmailCode(email); setStage('code'); setResendIn(30); }); else setError('Enter a full email address.'); }} />
        ) : (
          <>
            <Button label={busy === 'email' ? 'Checking…' : 'Verify and continue'} onPress={() => { if (code.length === 6) void run('email', () => verifyEmailCode(email, code, name)); else setError('The code has 6 digits.'); }} />
            <Row justify="space-between" wrap gap="sm">
              <LinkButton disabled={resendIn > 0} label={resendIn > 0 ? `Resend in ${resendIn} s` : 'Resend the code'} onPress={() => void run('send', async () => { await sendEmailCode(email); setResendIn(30); })} />
              <LinkButton label="Use a different email" onPress={() => { setStage('email'); setCode(''); }} />
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
      <Body muted>{`${sub}${answeredCount !== undefined ? ` ${answeredCount} answers so far.` : ''}`}</Body>
      {Platform.OS === 'ios' ? <AppleButton busy={busy === 'apple'} onPress={() => void run('apple', signInWithApple)} /> : null}
      <Button label={busy === 'google' ? 'Opening Google…' : 'Continue with Google'} variant="secondary" large onPress={() => void run('google', signInWithGoogle)} />
      <Button label="Email me a 6-digit code" variant="secondary" icon="mail" large onPress={() => setStage('email')} />
      {onLater ? <Button label={laterLabel} variant="ghost" accessibilityHint="Saved on this phone; we'll ask again at install." onPress={onLater} /> : null}
      {onLater && laterLabel !== 'Back' ? <Muted align="center">Saved on this phone; we'll ask again at install.</Muted> : null}
      {error ? <Reason>{error}</Reason> : null}
      <Card tone="muted">
        <CardTitle>Your account is the boundary around your Life Graph.</CardTitle>
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
