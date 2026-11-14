// Stepper arithmetic for the setup's sliders and times. Pure TS so apps/mobile/test can run it.

/**
 * One −/+ tap. From "Not set" the first tap starts at the suggested value moved by one step;
 * a time wraps around midnight (any time of day); a number stays inside its range.
 */
export function scaleStep(input: { type: string; min: number; max: number; value?: number; def: number; delta: number }): number {
  const from = input.value ?? input.def;
  const next = from + input.delta;
  if (input.type === 'time') return ((next % 1440) + 1440) % 1440;
  return Math.min(input.max, Math.max(input.min, next));
}

/** A typed whole number inside [min, max], else undefined (nothing is saved). */
export function typedNumber(text: string, min: number, max: number): number | undefined {
  if (!/^\d{1,4}$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : undefined;
}
