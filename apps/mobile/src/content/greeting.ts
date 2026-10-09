/** The greeting follows the clock: "Good morning" at 9 p.m. reads like nobody is home (docs/35 E18). */
export function greeting(hour: number): string {
  if (hour < 5) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** A usable IANA zone, else undefined (the device's own zone). */
function zoneOrDevice(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return timeZone; } catch { return undefined; }
}

/** The hour of `now` in the person's own time zone (Life Graph identity.timezone), never UTC. */
export function hourIn(now: Date, timeZone?: string): number {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zoneOrDevice(timeZone) }).format(now));
  return Number.isFinite(hour) ? hour % 24 : now.getHours();
}

/** Today's date as the person reads it: their time zone and locale, e.g. "Friday, October 9". */
export function todayLine(now: Date, timeZone?: string, locale?: string): string {
  const options = { weekday: 'long', month: 'long', day: 'numeric', timeZone: zoneOrDevice(timeZone) } as const;
  try { return new Intl.DateTimeFormat(locale, options).format(now); } catch { return new Intl.DateTimeFormat(undefined, options).format(now); }
}

/**
 * The name typed at sign-in that the identity Today greets with (user_profiles.display_name) still
 * lacks, else undefined. 9 Oct 2026: sign-in saved the name the instant the code was accepted,
 * BEFORE the 18+ record reached the server, so the age gate refused it (403) and the profile kept
 * "" while the auth profile held the name ("Hello, there."). The app now carries it over once the
 * account routes are open, and the same rule mends accounts that already lost it.
 */
export function nameToCarry(profileName: string | null | undefined, typedName: string | null | undefined): string | undefined {
  if ((profileName ?? '').trim()) return undefined;
  const clean = (typedName ?? '').trim().slice(0, 60);
  return clean || undefined;
}
