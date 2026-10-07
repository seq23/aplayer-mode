import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, useColorScheme, type TextStyle } from 'react-native';
import { useFonts } from 'expo-font';
import { Outfit_600SemiBold } from '@expo-google-fonts/outfit/600SemiBold';
import { NunitoSans_400Regular } from '@expo-google-fonts/nunito-sans/400Regular';
import { NunitoSans_600SemiBold } from '@expo-google-fonts/nunito-sans/600SemiBold';
import { NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans/700Bold';
import { readSync, writeSync } from '../intake/storage';
import { FONT_FAMILIES, NATIVE_FALLBACK, palettes, typeScale, type FontRole, type Palette, type SchemeName, type TypeKey } from './tokens';

/** System follows the phone; Light and Dark are the Settings override (Settings → Appearance). */
export type SchemePreference = 'system' | 'light' | 'dark';
const PREFERENCE_KEY = 'apm.appearance.v1';
/** The app never waits longer than this for the bundled fonts; it renders with the fallbacks. */
const FONT_WAIT_MS = 1500;

export interface Theme {
  scheme: SchemeName;
  preference: SchemePreference;
  setPreference: (next: SchemePreference) => void;
  colors: Palette;
  type: Record<TypeKey, TextStyle & { maxFontSizeMultiplier: number }>;
  /** Reduce Motion is on: no animated transitions (progress fills, toasts, disclosure). */
  reducedMotion: boolean;
}

function readPreference(): SchemePreference {
  try {
    const stored = readSync(PREFERENCE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch { return 'system'; }
}

/** The family for a role, with a real fallback: the web stack, or the platform system font. */
function family(role: FontRole, loaded: boolean): Pick<TextStyle, 'fontFamily' | 'fontWeight'> {
  const spec = FONT_FAMILIES[role];
  if (Platform.OS === 'web') return { fontFamily: `${spec.loaded}, ${spec.web}`, fontWeight: spec.weight };
  // A loaded custom face carries its own weight; adding fontWeight breaks it on Android.
  if (loaded) return { fontFamily: spec.loaded };
  return { fontFamily: NATIVE_FALLBACK[Platform.OS === 'android' ? 'android' : 'ios'][role], fontWeight: spec.weight };
}

function buildType(loaded: boolean): Theme['type'] {
  const out = {} as Theme['type'];
  for (const [key, spec] of Object.entries(typeScale) as Array<[TypeKey, (typeof typeScale)[TypeKey]]>) {
    out[key] = { ...family(spec.role, loaded), fontSize: spec.size, lineHeight: spec.line, letterSpacing: spec.tracking, maxFontSizeMultiplier: spec.maxScale };
  }
  return out;
}

const fallbackTheme: Theme = {
  scheme: 'light', preference: 'system', setPreference: () => undefined, colors: palettes.light, type: buildType(false), reducedMotion: false,
};
const ThemeContext = createContext<Theme>(fallbackTheme);

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduced(value); }).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; sub.remove(); };
  }, []);
  return reduced;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<SchemePreference>(readPreference);
  const [fontsLoaded, fontError] = useFonts({ Outfit_600SemiBold, NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold });
  const [waited, setWaited] = useState(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => { const t = setTimeout(() => setWaited(true), FONT_WAIT_MS); return () => clearTimeout(t); }, []);

  const scheme: SchemeName = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
  const value = useMemo<Theme>(() => ({
    scheme,
    preference,
    setPreference: (next) => { setPreferenceState(next); try { writeSync(PREFERENCE_KEY, next); } catch { /* memory only */ } },
    colors: palettes[scheme],
    type: buildType(fontsLoaded),
    reducedMotion,
  }), [scheme, preference, fontsLoaded, reducedMotion]);

  // Hold the first frame briefly for the fonts (no flash of the fallback), never longer.
  if (!fontsLoaded && !fontError && !waited) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Theme-aware styles, rebuilt only when the scheme or fonts change. */
export function useThemedStyles<T extends Record<string, object>>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(factory(theme)) as T, [theme.colors, theme.type]);
}
