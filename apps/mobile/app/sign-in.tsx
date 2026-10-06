import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Body, Button, Card, CardTitle, Label, Screen, uiStyles } from '../src/components/ui';
import { useSession } from '../src/state/session';
import { colors, radius, spacing } from '../src/theme';

export default function SignInScreen() {
  const { status, error: sessionError, signIn, signUp } = useSession();
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (status === 'signed_in') router.replace('/');
  }, [status]);

  const ready = email.trim().includes('@') && password.length >= 8 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setMessage(undefined);
    try {
      if (mode === 'sign_in') {
        await signIn(email, password);
      } else {
        const result = await signUp(email, password);
        if (result.needsEmailConfirmation) {
          setMessage('Check your email to confirm your account, then come back and sign in.');
          setMode('sign_in');
        }
      }
    } catch {
      // SessionProvider exposes a safe message below.
    } finally {
      setBusy(false);
    }
  };

  if (status === 'unconfigured') {
    return (
      <Screen
        eyebrow="Account"
        title="This build still needs its Supabase mobile configuration."
        subtitle="No private data will be sent until the app has the project URL and publishable key."
      >
        <Card tone="warning">
          <CardTitle>Development configuration missing</CardTitle>
          <Body muted>Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY to the mobile environment.</Body>
        </Card>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen
      eyebrow="Your APM account"
      title={mode === 'sign_up' ? 'Create your private APM.' : 'Welcome back.'}
      subtitle="Your account keeps your Life Graph separate from everyone else's and lets your system survive app restarts."
    >
      <Card tone="accent">
        <CardTitle>Your account is the boundary around your Life Graph.</CardTitle>
        <Body muted>APM uses Supabase Auth for identity. The Cloudflare APM API verifies your session before accessing user-scoped data.</Body>
      </Card>

      <View style={uiStyles.stack}>
        <View style={styles.field}>
          <Label>Email</Label>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.inkMuted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            style={styles.input}
          />
        </View>
        <View style={styles.field}>
          <Label>Password</Label>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            placeholderTextColor={colors.inkMuted}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />
        </View>
      </View>

      {message ? (
        <Card>
          <Body>{message}</Body>
        </Card>
      ) : null}

      {sessionError ? (
        <Card tone="danger">
          <Body>{sessionError}</Body>
        </Card>
      ) : null}

      <Button
        label={busy ? 'Working…' : mode === 'sign_up' ? 'Create my account' : 'Sign in'}
        onPress={submit}
      />
      <Button
        label={mode === 'sign_up' ? 'I already have an account' : 'Create a new account'}
        variant="secondary"
        onPress={() => {
          setMessage(undefined);
          setMode((current) => (current === 'sign_up' ? 'sign_in' : 'sign_up'));
        }}
      />
      {!ready && !busy ? <Body muted>Use a valid email and a password with at least 8 characters.</Body> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.ink,
    fontSize: 16,
  },
});
