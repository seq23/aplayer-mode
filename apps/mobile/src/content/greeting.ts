/** The greeting follows the clock: "Good morning" at 9 p.m. reads like nobody is home (docs/35 E18). */
export function greeting(hour: number): string {
  if (hour < 5) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
