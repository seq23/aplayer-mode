import type { Palette } from './tokens';

/** WCAG 2.x relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA thresholds: 4.5 for body text, 3 for large text and UI parts (borders, progress, icons). */
export const AA_TEXT = 4.5;
export const AA_UI = 3;

type Key = keyof Palette;
/**
 * Every foreground/background pairing the primitives actually render (src/components/ui.tsx).
 * A primitive that puts a new token on a new background adds its pair here; the test checks
 * the whole list in both schemes.
 */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [fg: Key, bg: Key, min: number, where: string]> = [
  ['ink', 'bg', AA_TEXT, 'screen text'],
  ['ink', 'surface', AA_TEXT, 'card text'],
  ['ink', 'surfaceMuted', AA_TEXT, 'muted card text'],
  ['ink', 'accentSoft', AA_TEXT, 'accent card text'],
  ['ink', 'warningSoft', AA_TEXT, 'warning card text'],
  ['ink', 'dangerSoft', AA_TEXT, 'danger card text'],
  ['inkMuted', 'bg', AA_TEXT, 'secondary text on the screen'],
  ['inkMuted', 'surface', AA_TEXT, 'secondary text in a card'],
  ['inkMuted', 'surfaceMuted', AA_TEXT, 'secondary text in a muted card'],
  ['inkMuted', 'accentSoft', AA_TEXT, 'secondary text in an accent card'],
  ['inkMuted', 'warningSoft', AA_TEXT, 'secondary text in a warning card'],
  ['inkMuted', 'dangerSoft', AA_TEXT, 'secondary text in a danger card'],
  ['accent', 'bg', AA_TEXT, 'links and eyebrows on the screen'],
  ['accent', 'surface', AA_TEXT, 'links in a card'],
  ['accent', 'accentSoft', AA_TEXT, 'badges and the active tab label'],
  ['onPrimary', 'primary', AA_TEXT, 'primary button'],
  ['onAccent', 'accent', AA_TEXT, 'accent button'],
  ['onChipOn', 'chipOn', AA_TEXT, 'selected chip and answer card'],
  ['onDanger', 'danger', AA_TEXT, 'destructive button'],
  ['warning', 'warningSoft', AA_TEXT, 'warning text in its card'],
  ['warning', 'surface', AA_TEXT, 'warning text in a card'],
  ['warning', 'bg', AA_TEXT, 'inline reasons on the screen'],
  ['danger', 'dangerSoft', AA_TEXT, 'error text in its card'],
  ['danger', 'surface', AA_TEXT, 'error text in a card'],
  ['success', 'successSoft', AA_TEXT, 'success badge'],
  ['lineStrong', 'bg', AA_UI, 'field and secondary-button border on the screen'],
  ['lineStrong', 'surface', AA_UI, 'field and secondary-button border in a card'],
  ['accent', 'line', AA_UI, 'progress fill on its track'],
  ['inkMuted', 'surface', AA_UI, 'inactive tab icon'],
  ['brass', 'surface', 2, 'decorative brass hairline (not a control; WCAG does not apply, kept visible)'],
];

/** The pairs that fall short in a palette, with their ratio (empty = all pass). */
export function failingPairs(palette: Palette): Array<{ fg: Key; bg: Key; ratio: number; min: number; where: string }> {
  return CONTRAST_PAIRS
    .map(([fg, bg, min, where]) => ({ fg, bg, min, where, ratio: contrastRatio(palette[fg], palette[bg]) }))
    .filter((pair) => pair.ratio < pair.min);
}
