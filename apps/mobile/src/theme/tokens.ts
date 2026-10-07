/**
 * The A Player Mode design tokens: the ONLY place a color value or a font family is written
 * (test/design-system.test.mjs fails on either anywhere else).
 *
 * Direction (owner's pick, 7 Oct 2026): "C · Calm clarity" for type, shape, spacing and
 * layout, recoloured with "A · Quiet luxury" (Stone, Paper, Ink, Graphite, Moss, brass
 * hairline), plus a warm dark mode of the A palette. Every text/background pair below is
 * checked for WCAG AA in BOTH schemes by the contrast test (src/theme/contrast.ts).
 *
 * Pure data: no React Native import, so the tests can bundle and check it directly.
 */

export type SchemeName = 'light' | 'dark';

export interface Palette {
  /** Screen background (A: Stone). */
  bg: string;
  /** Cards, fields, the tab bar (A: Paper). */
  surface: string;
  /** Quieter cards (notes, terms, "muted" tone). */
  surfaceMuted: string;
  /** Main text (A: Ink). */
  ink: string;
  /** Secondary text (A: Graphite, deepened to pass AA on Stone). */
  inkMuted: string;
  /** Decorative hairlines and dividers (A: line). */
  line: string;
  /** Borders that identify a control (fields, secondary buttons): ≥ 3:1 on bg and surface. */
  lineStrong: string;
  /** The brass hairline: plate rules, bullets, the sticky-footer rule. */
  brass: string;
  /** Moss: accent buttons, links, progress, the active tab. */
  accent: string;
  onAccent: string;
  /** Moss-tinted surface (accent cards, the active tab pill, highlighted cells). */
  accentSoft: string;
  /** Primary buttons (A: Ink with Paper text). */
  primary: string;
  onPrimary: string;
  /** Selected chips and answer cards (A: Ink with Paper text). */
  chipOn: string;
  onChipOn: string;
  warning: string;
  warningSoft: string;
  danger: string;
  onDanger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  /** Drop shadow color for raised elements (toast, sticky footer). */
  shadow: string;
}

/** A · Quiet luxury, light. Values from the direction board; Graphite deepened 6E685F → 655F57 (4.39 → 5.03 on Stone). */
const light: Palette = {
  bg: '#E9E5DE',
  surface: '#F6F4F0',
  surfaceMuted: '#EFEBE4',
  ink: '#1E1C19',
  inkMuted: '#655F57',
  line: '#D4CEC4',
  lineStrong: '#8A8170',
  brass: '#A39780',
  accent: '#3E4B3C',
  onAccent: '#F6F4F0',
  accentSoft: '#E3E6DC',
  primary: '#1E1C19',
  onPrimary: '#F6F4F0',
  chipOn: '#1E1C19',
  onChipOn: '#F6F4F0',
  warning: '#7A5A1E',
  warningSoft: '#F2EAD9',
  danger: '#9C3E33',
  onDanger: '#F6F4F0',
  dangerSoft: '#F1E3DE',
  success: '#3E4B3C',
  successSoft: '#E3E6DC',
  shadow: '#1E1C19',
};

/**
 * A · Quiet luxury, dark (designed for this build): warm near-black stone, a slightly lifted
 * warm surface, ivory text, warm grey secondary text, moss lifted for contrast, brass lines.
 * Primary and selected states invert to ivory with stone text, as Ink-on-Paper does in light.
 */
const dark: Palette = {
  bg: '#1B1916',
  surface: '#25221E',
  surfaceMuted: '#2E2A25',
  ink: '#EDE7DC',
  inkMuted: '#A9A193',
  line: '#3A352F',
  lineStrong: '#8C8069',
  brass: '#8C8069',
  accent: '#A3B49A',
  onAccent: '#1B1916',
  accentSoft: '#2C3329',
  primary: '#EDE7DC',
  onPrimary: '#1B1916',
  chipOn: '#EDE7DC',
  onChipOn: '#1B1916',
  warning: '#D8B46E',
  warningSoft: '#352D1E',
  danger: '#E8A090',
  onDanger: '#1B1916',
  dangerSoft: '#3A2622',
  success: '#A3B49A',
  successSoft: '#2C3329',
  shadow: '#000000',
};

export const palettes: Readonly<Record<SchemeName, Palette>> = { light, dark };

/** C's rhythm: 4-based, generous. */
export const spacing = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32, xxxl: 44 } as const;
export type SpaceKey = keyof typeof spacing;

/** C's soft, rounded shapes: pill buttons and chips, 20 pt answer cards, 24 pt feature cards. */
export const radius = { sm: 12, md: 16, lg: 20, xl: 24, pill: 999 } as const;

/** Minimum tap target (Apple HIG 44 pt); answer cards and primary buttons are taller. */
export const tap = { min: 44, button: 52, primary: 56, answer: 64 } as const;

/** Elevation: C is flat with hairline rings; only floating elements get a soft shadow. */
export const elevation = {
  none: { shadowOpacity: 0, elevation: 0 },
  raised: { shadowOffset: { width: 0, height: 6 }, shadowRadius: 18, shadowOpacity: 0.12, elevation: 4 },
} as const;

/** Font roles. The families (and their fallbacks) are resolved in fonts.ts. */
export type FontRole = 'display' | 'body' | 'bodySemi' | 'bodyBold';

export const FONT_FAMILIES: Readonly<Record<FontRole, { loaded: string; weight: '400' | '600' | '700'; web: string }>> = {
  display: { loaded: 'Outfit_600SemiBold', weight: '600', web: '"Avenir Next", "Century Gothic", -apple-system, system-ui, sans-serif' },
  body: { loaded: 'NunitoSans_400Regular', weight: '400', web: '"Avenir Next", -apple-system, "Segoe UI", system-ui, sans-serif' },
  bodySemi: { loaded: 'NunitoSans_600SemiBold', weight: '600', web: '"Avenir Next", -apple-system, "Segoe UI", system-ui, sans-serif' },
  bodyBold: { loaded: 'NunitoSans_700Bold', weight: '700', web: '"Avenir Next", -apple-system, "Segoe UI", system-ui, sans-serif' },
};

/** Native fallbacks when the bundled fonts have not loaded (system fonts in the same spirit). */
export const NATIVE_FALLBACK: Readonly<Record<'ios' | 'android', Readonly<Record<FontRole, string>>>> = {
  ios: { display: 'Avenir Next', body: 'Avenir Next', bodySemi: 'Avenir Next', bodyBold: 'Avenir Next' },
  android: { display: 'sans-serif-medium', body: 'sans-serif', bodySemi: 'sans-serif-medium', bodyBold: 'sans-serif' },
};

/** The type scale (C): Outfit 600 for display, Nunito Sans for reading. Sizes scale with Dynamic Type. */
export const typeScale = {
  hero: { role: 'display', size: 40, line: 44, tracking: -1, maxScale: 1.4 },
  display: { role: 'display', size: 32, line: 38, tracking: -0.6, maxScale: 1.5 },
  question: { role: 'display', size: 28, line: 34, tracking: -0.5, maxScale: 1.6 },
  heading: { role: 'display', size: 22, line: 28, tracking: -0.2, maxScale: 1.8 },
  cardTitle: { role: 'display', size: 18, line: 24, tracking: -0.1, maxScale: 2 },
  button: { role: 'display', size: 17, line: 22, tracking: 0, maxScale: 1.8 },
  body: { role: 'body', size: 16, line: 24, tracking: 0, maxScale: 2.2 },
  bodyStrong: { role: 'bodyBold', size: 16, line: 24, tracking: 0, maxScale: 2.2 },
  small: { role: 'body', size: 14, line: 20, tracking: 0, maxScale: 2.2 },
  smallStrong: { role: 'bodySemi', size: 14, line: 20, tracking: 0, maxScale: 2.2 },
  chip: { role: 'bodySemi', size: 15, line: 20, tracking: 0, maxScale: 2 },
  label: { role: 'bodyBold', size: 12, line: 16, tracking: 1.2, maxScale: 2 },
  tab: { role: 'bodySemi', size: 11, line: 16, tracking: 0.2, maxScale: 1.4 },
} as const satisfies Record<string, { role: FontRole; size: number; line: number; tracking: number; maxScale: number }>;
export type TypeKey = keyof typeof typeScale;
