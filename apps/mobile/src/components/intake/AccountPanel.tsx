import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSession, type AccountProvider, type AccountResult } from '../../state/session';
import { Body, Card, CardTitle } from '../ui';
import { colors, radius, spacing } from '../../theme';
import { Muted, OptionButton, intakeStyles } from './primitives';

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
        <Text accessibilityRole="header" style={intakeStyles.heading}>{stage === 'email' ? 'Your email' : 'Check your email'}</Text>
        <Body muted>{stage === 'email' ? 'We\'ll send a 6-digit code. You type it here; you never leave the app.' : `We sent a 6-digit code to ${email.trim()}. Type it here.`}</Body>
        {stage === 'email' ? (
          <TextInput accessibilityLabel="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" placeholderTextColor={colors.inkMuted} style={styles.input} />
        ) : (
          <>
            <TextInput accessibilityLabel="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" placeholderTextColor={colors.inkMuted} style={[styles.input, styles.code]} />
            <TextInput accessibilityLabel="First name" value={name} onChangeText={setName} autoComplete="given-name" textContentType="givenName" placeholder="First name" placeholderTextColor={colors.inkMuted} style={styles.input} />
          </>
        )}
        {error ? <Text style={intakeStyles.why} accessibilityLiveRegion="polite">{error}</Text> : null}
        {stage === 'email' ? (
          <OptionButton role="button" label={busy === 'send' ? 'Sending…' : 'Email me a 6-digit code'} selected={false} onPress={() => { if (validEmail) void run('send', async () => { await sendEmailCode(email); setStage('code'); setResendIn(30); }); else setError('Enter a full email address.'); }} />
        ) : (
          <>
            <OptionButton role="button" label={busy === 'email' ? 'Checking…' : 'Verify and continue'} selected={false} onPress={() => { if (code.length === 6) void run('email', () => verifyEmailCode(email, code, name)); else setError('The code has 6 digits.'); }} />
            <View style={styles.row}>
              <Pressable accessibilityRole="button" disabled={resendIn > 0} onPress={() => void run('send', async () => { await sendEmailCode(email); setResendIn(30); })} style={styles.link}>
                <Text style={[styles.linkText, resendIn > 0 && styles.dim]}>{resendIn > 0 ? `Resend in ${resendIn} s` : 'Resend the code'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => { setStage('email'); setCode(''); }} style={styles.link}><Text style={styles.linkText}>Use a different email</Text></Pressable>
            </View>
          </>
        )}
        <Pressable accessibilityRole="button" onPress={() => { setStage('choose'); setError(undefined); }} style={styles.link}><Text style={styles.linkText}>Back to the options</Text></Pressable>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={intakeStyles.stack}>
      <Text accessibilityRole="header" style={intakeStyles.heading}>{title}</Text>
      <Body muted>{`${sub}${answeredCount !== undefined ? ` ${answeredCount} answers so far.` : ''}`}</Body>
      {Platform.OS === 'ios' ? <AppleButton busy={busy === 'apple'} onPress={() => void run('apple', signInWithApple)} /> : null}
      <OptionButton role="button" label={busy === 'google' ? 'Opening Google…' : 'Continue with Google'} selected={false} onPress={() => void run('google', signInWithGoogle)} />
      <OptionButton role="button" label="Email me a 6-digit code" selected={false} onPress={() => setStage('email')} />
      {onLater ? <OptionButton role="button" label={laterLabel} detail="Saved on this phone; we'll ask again at install." selected={false} onPress={onLater} /> : null}
      {error ? <Text style={intakeStyles.why} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Card tone="muted">
        <CardTitle>Your account is the boundary around your Life Graph.</CardTitle>
        <Muted>No passwords. Private-life AI uses zero-retention, no-training routes only.</Muted>
        <Pressable accessibilityRole="link" onPress={() => router.push('/settings/privacy')}><Text style={styles.linkText}>How APM protects your data</Text></Pressable>
      </Card>
    </View>
  );
}

/** The system Apple button (iOS only); the module is required lazily so web/Android never load it. */
function AppleButton({ onPress, busy }: { onPress: () => void; busy: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Apple = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  return (
    <View accessibilityLabel="Continue with Apple" style={busy ? styles.dim : undefined}>
      <Apple.AppleAuthenticationButton
        buttonType={Apple.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={Apple.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={radius.md}
        style={styles.apple}
        onPress={onPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 52, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 18, color: colors.ink },
  code: { letterSpacing: 6, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: colors.accent, fontWeight: '800', fontSize: 15 },
  dim: { opacity: 0.5 },
  apple: { width: '100%', height: 52 },
});
