import { router } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AccountPanel } from '../src/components/intake/AccountPanel';
import { colors, spacing } from '../src/theme';

/** "I already have an account": straight to Today, or to the next unanswered question if setup is unfinished. */
export default function AccountScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <AccountPanel
          title="Welcome back"
          sub="Sign in the way you saved your plan. No passwords."
          onDone={() => router.replace('/')}
          onLater={() => router.back()}
          laterLabel="Back"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  body: { padding: spacing.md, gap: spacing.md },
});
