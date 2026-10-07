// The design system's public face. Colors are read through useTheme() (never imported as a
// static palette), so every screen follows the light/dark scheme; tokens.ts holds the values.
export { ThemeProvider, useReducedMotion, useTheme, useThemedStyles, type SchemePreference, type Theme } from './ThemeProvider';
export { elevation, radius, spacing, tap, type Palette, type SchemeName, type SpaceKey, type TypeKey } from './tokens';
