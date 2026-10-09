import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AvatarButton, Button, LinkButton, Muted, Small } from './ui';
import { spacing, radius, elevation, useThemedStyles, type Theme } from '../theme';
import { useSession } from '../state/session';
import { fetchProductPlan, type ProductPlanResponse } from '../api/apmApi';
import { accountInitial, accountMenuShown } from '../content/accountMenu';
import { planSummary } from '../billing/planSummary';
import { plainError } from '../api/errors';

/**
 * Top right of every signed-in page (owner, 9 Oct 2026): her initial; tapped, it shows the email
 * she is signed in with, her current plan (the SAME source as Settings, GET /v1/product/plan)
 * and Sign out. Hidden on the signed-out and setup pages (accountMenuShown).
 */
export function AccountMenu() {
  const { status, user, isAnonymous, accessToken, signOut } = useSession();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const s = useThemedStyles(menuStyles);
  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState<ProductPlanResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shown = accountMenuShown(pathname, status === 'signed_in' && !isAnonymous && Boolean(user?.email));

  useEffect(() => { setOpen(false); }, [pathname, user?.id]);
  useEffect(() => {
    if (!open || !accessToken) return;
    let active = true;
    fetchProductPlan(accessToken).then((next) => { if (active) setProduct(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [open, accessToken]);

  if (!shown || !user?.email) return null;
  const leave = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await signOut(); setOpen(false); router.replace('/welcome'); }
    catch (cause) { setError(plainError(cause, 'Sign-out did not finish. Try again.')); }
    finally { setBusy(false); }
  };

  return (
    <View pointerEvents="box-none" style={[s.anchor, { top: insets.top + spacing.xs }]}>
      <AvatarButton initial={accountInitial(user.email)} label={open ? 'Close account menu' : `Account: ${user.email}`} expanded={open} onPress={() => setOpen((v) => !v)} />
      {open ? (
        <View style={s.panel}>
          <Muted>Signed in as</Muted>
          <Small strong>{user.email}</Small>
          <Muted>Plan</Muted>
          <Small>{product ? (planSummary(product.entitlement) ?? 'No plan yet') : 'Loading your plan…'}</Small>
          <LinkButton label="Settings" onPress={() => { setOpen(false); router.push('/settings'); }} />
          {error ? <Small tone="warning">{error}</Small> : null}
          <Button label={busy ? 'Signing out…' : 'Sign out'} variant="secondary" busy={busy} onPress={() => leave()} />
        </View>
      ) : null}
    </View>
  );
}

const menuStyles = ({ colors }: Theme) => ({
  anchor: { position: 'absolute' as const, right: spacing.md, alignItems: 'flex-end' as const, gap: spacing.xs, zIndex: 20 },
  panel: { minWidth: 240, maxWidth: 320, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xxs, ...elevation.raised, shadowColor: colors.shadow },
});
