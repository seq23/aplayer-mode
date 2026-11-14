// iOS SecureStore only accepts keys of letters, digits, ".", "-" and "_". Anything else throws,
// and a throw inside the sign-in storage left the app stuck on "Opening your APM…" (14 Nov 2026).
export function secureStoreKey(key: string, part: string | number): string {
  return `${key}.${part}`.replace(/[^A-Za-z0-9._-]/g, '_');
}
