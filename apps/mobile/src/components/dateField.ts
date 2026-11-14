// "YYYY-MM-DD" answers ↔ the phone's local calendar day. Pure TS (no React Native), so tests can run it.

export function isoToLocalDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

export function localDateToIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** "Friday 12 December", in the phone's own style; "" when unset. */
export function longDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return isoToLocalDate(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
