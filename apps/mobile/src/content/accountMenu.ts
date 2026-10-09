// The account menu (src/components/AccountMenu.tsx): where it shows and what the round button
// says. Pure, so apps/mobile/test runs it in Node.

/** Pages that are signed-out or setup steps: no account menu there. */
export const ACCOUNT_MENU_HIDDEN: ReadonlySet<string> = new Set(['/', '/welcome', '/age', '/join', '/health-consent', '/intake', '/account']);

/** Every signed-in page (a real account, not an anonymous draft) except the setup steps. */
export function accountMenuShown(pathname: string | undefined, signedInAccount: boolean): boolean {
  if (!signedInAccount) return false;
  const path = (pathname ?? '/').replace(/\/+$/, '') || '/';
  return !ACCOUNT_MENU_HIDDEN.has(path);
}

/** The first letter of the email, upper case; "?" when there is none. */
export function accountInitial(email: string | undefined): string {
  const first = (email ?? '').trim().match(/[\p{L}\p{N}]/u)?.[0];
  return first ? first.toLocaleUpperCase() : '?';
}
