// The design system (the restyle, 7 Oct 2026: "C · Calm clarity" shapes and type, "A · Quiet
// luxury" colour, plus a warm dark mode). Pins: ONE token source; no raw colours or fonts
// outside src/theme; screens built only from the primitives; WCAG AA for every token pair in
// BOTH schemes; tap targets, labels, Dynamic Type and Reduce Motion in the primitives. Each
// guard is proved negatively: break it, watch it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { lintDesign } from '../scripts/design-lint.mjs';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const src = (path) => readFile(join(appDir, path), 'utf8');
let outDir; let tokens; let contrast;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-design-'));
  await build({
    entryPoints: { tokens: join(appDir, 'src/theme/tokens.ts'), contrast: join(appDir, 'src/theme/contrast.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  tokens = await import(pathToFileURL(join(outDir, 'tokens.js')).href);
  contrast = await import(pathToFileURL(join(outDir, 'contrast.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the palette
test('the light palette is the owner\'s A palette (Stone, Paper, Ink, Moss, line, brass), Graphite deepened only for AA', () => {
  const light = tokens.palettes.light;
  assert.deepEqual(
    { bg: light.bg, surface: light.surface, ink: light.ink, accent: light.accent, line: light.line, brass: light.brass, primary: light.primary, onPrimary: light.onPrimary, chipOn: light.chipOn, onChipOn: light.onChipOn },
    { bg: '#E9E5DE', surface: '#F6F4F0', ink: '#1E1C19', accent: '#3E4B3C', line: '#D4CEC4', brass: '#A39780', primary: '#1E1C19', onPrimary: '#F6F4F0', chipOn: '#1E1C19', onChipOn: '#F6F4F0' },
  );
  // Graphite #6E685F on Stone is 4.39:1, short of AA body text; the token is the nearest warm grey that passes.
  assert.ok(contrast.contrastRatio('#6E685F', '#E9E5DE') < contrast.AA_TEXT);
  assert.equal(light.inkMuted, '#655F57');
});

test('the dark palette is warm: a near-black stone (not pure black, not blue-black), ivory text, lifted moss', () => {
  const dark = tokens.palettes.dark;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = rgb(dark.bg);
  assert.ok(r + g + b > 0, 'not pure black');
  assert.ok(r >= g && g >= b && r > b, `${dark.bg} is warm (red ≥ green ≥ blue), not blue-black`);
  assert.ok(contrast.luminance(dark.surface) > contrast.luminance(dark.bg), 'the surface is lifted');
  const [ir, , ib] = rgb(dark.ink);
  assert.ok(ir > ib, `${dark.ink} is a warm ivory`);
  assert.ok(contrast.luminance(dark.accent) > contrast.luminance(tokens.palettes.light.accent), 'moss is lifted for contrast');
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(tokens.palettes.light).sort(), 'both schemes define every token');
});

test('WCAG AA: every token pair the primitives render passes in BOTH schemes (4.5:1 text, 3:1 UI)', () => {
  assert.ok(contrast.CONTRAST_PAIRS.length >= 25, 'the pair list is not empty or trimmed');
  for (const scheme of ['light', 'dark']) {
    const failing = contrast.failingPairs(tokens.palettes[scheme]);
    assert.deepEqual(failing, [], `${scheme}: ${failing.map((f) => `${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)} < ${f.min} (${f.where})`).join('; ')}`);
  }
});

test('the contrast check FAILS on a palette that misses AA (negative proof)', () => {
  const graphite = { ...tokens.palettes.light, inkMuted: '#6E685F' };
  assert.ok(contrast.failingPairs(graphite).some((f) => f.fg === 'inkMuted' && f.bg === 'bg'), 'the original Graphite on Stone is caught');
  const dim = { ...tokens.palettes.dark, ink: '#5A554D' };
  assert.ok(contrast.failingPairs(dim).some((f) => f.fg === 'ink'), 'dim dark-mode text is caught');
  const weakBorder = { ...tokens.palettes.dark, lineStrong: tokens.palettes.dark.line };
  assert.ok(contrast.failingPairs(weakBorder).some((f) => f.fg === 'lineStrong' && f.min === contrast.AA_UI), 'a control border under 3:1 is caught');
});

test('type: Outfit 600 for display, Nunito Sans for reading, with real fallbacks; every size scales', () => {
  assert.equal(tokens.FONT_FAMILIES.display.loaded, 'Outfit_600SemiBold');
  assert.match(tokens.FONT_FAMILIES.body.loaded, /^NunitoSans_/);
  for (const role of Object.values(tokens.FONT_FAMILIES)) assert.match(role.web, /sans-serif/, 'the web stack ends in a generic family');
  for (const platform of ['ios', 'android']) for (const role of Object.keys(tokens.FONT_FAMILIES)) assert.ok(tokens.NATIVE_FALLBACK[platform][role], `${platform} ${role} fallback`);
  for (const [key, spec] of Object.entries(tokens.typeScale)) {
    assert.ok(spec.maxScale >= 1.4, `${key} scales with Dynamic Type (max ×${spec.maxScale})`);
    assert.ok(spec.line >= spec.size, `${key} line height never clips its glyphs`);
  }
});

// ---------------------------------------------------------------- the lint
test('design-lint passes on the app: colours and fonts only in src/theme, screens built from the primitives', async () => {
  const { files, violations } = await lintDesign(appDir);
  assert.ok(files > 40, `scanned ${files} files`);
  assert.deepEqual(violations, []);
});

test('design-lint FAILS on each violation (negative proof)', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'apm-design-lint-'));
  try {
    await cp(join(appDir, 'app'), join(copy, 'app'), { recursive: true });
    await cp(join(appDir, 'src'), join(copy, 'src'), { recursive: true });
    const breaks = [
      ['app/hex.tsx', "export const c = { color: '#FF0000' };", /raw colour literal/],
      ['src/rgba.ts', "export const c = 'rgba(0,0,0,0.5)';", /raw rgb\(\)/],
      ['src/components/font.tsx', "export const t = { fontFamily: 'Georgia' };", /raw font family/],
      ['src/palette.ts', "import { palettes } from './theme/tokens'; export const p = palettes;", /imports the token file directly/],
      ['app/sheet.tsx', "import { StyleSheet } from 'react-native'; export const s = StyleSheet.create({});", /own StyleSheet/],
      ['app/inline.tsx', 'export const X = () => <View style={{ padding: 4 }} />;', /inline style object/],
      ['app/text.tsx', 'export const X = () => <Text>hi</Text>;', /raw <Text>/],
      ['src/components/press.tsx', 'export const X = () => <Pressable onPress={() => undefined} />;', /raw control outside the primitives/],
      ['src/components/scale.tsx', 'export const X = () => <Body allowFontScaling={false}>hi</Body>;', /allowFontScaling/],
    ];
    for (const [file, body, expected] of breaks) {
      await writeFile(join(copy, file), body);
      const { violations } = await lintDesign(copy);
      assert.ok(violations.some((v) => expected.test(v)), `${file} must fail the lint (got: ${violations.join(' | ') || 'nothing'})`);
      await rm(join(copy, file));
    }
    // An unlabelled control inside the primitives themselves.
    const uiPath = join(copy, 'src/components/ui.tsx');
    const ui = await readFile(uiPath, 'utf8');
    const unlabelled = ui.replace('accessibilityLabel={accessibilityLabel ?? label}\n      accessibilityHint={showReason ? disabledReason : accessibilityHint}', 'accessibilityHint={showReason ? disabledReason : accessibilityHint}');
    assert.notEqual(unlabelled, ui, 'the break was planted (the Button source still has the line it removes)');
    await writeFile(uiPath, unlabelled);
    assert.ok((await lintDesign(copy)).violations.some((v) => /<Pressable> without an accessibilityLabel/.test(v)), 'an unlabelled Button is caught');
    await writeFile(uiPath, ui);
    assert.deepEqual((await lintDesign(copy)).violations, [], 'restored copy passes again');
    assert.ok((await lintDesign(join(copy, 'nothing-here'))).violations.some((v) => /NO SOURCE FILES/.test(v)), 'zero files is a failure, not a pass');
  } finally { await rm(copy, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- accessibility in the primitives
test('primitives: ≥ 44 pt tap targets, Reduce Motion respected, the scheme follows the system with a Settings override', async () => {
  assert.ok(tokens.tap.min >= 44 && tokens.tap.button >= 44 && tokens.tap.answer >= 44);
  const ui = await src('src/components/ui.tsx');
  for (const needle of ['minHeight: tap.button', 'minHeight: tap.min, minWidth: tap.min', 'minHeight: tap.answer', "link: { minHeight: tap.min", 'width: tap.primary, height: tap.primary']) assert.ok(ui.includes(needle), `tap target: ${needle}`);
  assert.doesNotMatch(ui, /minHeight: ([0-9]|[1-3][0-9]|4[0-3])\b/, 'no control under 44 pt');
  assert.match(ui, /if \(reducedMotion\) \{ width\.setValue\(pct\); return; \}/, 'progress does not animate under Reduce Motion');
  assert.match(ui, /if \(reducedMotion\) \{ opacity\.setValue\(1\); return; \}/, 'toasts do not fade under Reduce Motion');
  assert.match(ui, /pressed && !reducedMotion && s\.pressedScale/, 'no press-scale under Reduce Motion');
  assert.match(ui, /maxFontSizeMultiplier=\{maxFontSizeMultiplier\}/, 'text scales with Dynamic Type (bounded per style, never off)');
  const provider = await src('src/theme/ThemeProvider.tsx');
  assert.match(provider, /useColorScheme\(\)/, 'follows the system setting');
  assert.match(provider, /preference === 'system' \? \(system === 'dark' \? 'dark' : 'light'\) : preference/);
  assert.match(provider, /isReduceMotionEnabled\(\)/);
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /\{ id: 'system', label: 'System' \}, \{ id: 'light', label: 'Light' \}, \{ id: 'dark', label: 'Dark' \}/, 'Settings → Appearance: System / Light / Dark');
  assert.match(settings, /onChange=\{setPreference\}/);
  const layout = await src('app/_layout.tsx');
  assert.match(layout, /<ThemeProvider>/);
  assert.match(layout, /barStyle=\{scheme === 'dark' \? 'light-content' : 'dark-content'\}/);
});

// ---------------------------------------------------------------- the design-phase leftovers (docs/35 U8–U11)
test('U8: the coach tab has ONE primary (start coaching); the other modes and the rulebook are tucked away', async () => {
  const coach = await src('app/(tabs)/apm.tsx');
  const beforeFold = coach.slice(0, coach.indexOf('<Disclosure'));
  assert.equal((beforeFold.match(/large icon="message-circle"/g) ?? []).length, 1, 'one large primary above the fold');
  assert.doesNotMatch(beforeFold, /MODE_ORDER\.filter/, 'the mode list is not above the fold');
  assert.match(coach, /<Disclosure icon="sliders" title="Other modes"/);
  assert.match(coach, /<Disclosure icon="book-open" title="Your rulebook"/);
});

test('U9/U10: Today leads with the summary and the one next step, folds the rest, and speaks plain words', async () => {
  const today = await src('app/(tabs)/today.tsx');
  const firstFold = today.indexOf('<Disclosure');
  const checkIn = today.indexOf('TODAY_COPY.checkInButton');
  const firstHour = today.indexOf('Begin my First Hour');
  assert.ok(firstFold > 0 && checkIn > 0 && firstHour > 0, 'the check-in, the First Hour and a fold are all on Today');
  assert.ok(checkIn < firstFold && firstHour < firstFold, 'the check-in and the First Hour sit above the fold');
  for (const folded of ["title=\"Today's agenda\"", 'title="More for today"', 'title="Close the day"']) assert.ok(today.includes(folded), `${folded} is a disclosure`);
  assert.doesNotMatch(today, /REPRINT|Reprinted|Invalid agenda|Locked for today|'Preview'|Server-backed/, 'no engineering words on Today');
  assert.doesNotMatch(today, /item\.kind\.replace\('_', ' '\)\}<\/Pill>/, 'agenda item kinds read as words, not keys');
});

test('U11: times are chosen with a native time picker, never typed as HH:MM', async () => {
  for (const rel of ['app/settings/notifications.tsx', 'app/settings/autopilot.tsx', 'app/settings/os.tsx']) {
    const text = await src(rel);
    assert.match(text, /<TimePicker\b/, `${rel} uses the time picker`);
    assert.doesNotMatch(text, /placeholder="[^"]*HH:MM|label="[^"]*HH:MM|\(24-hour/, `${rel} asks nobody to type HH:MM`);
  }
  const native = await src('src/components/TimePickerField.tsx');
  assert.match(native, /@react-native-community\/datetimepicker/);
  assert.match(native, /DateTimePickerAndroid\.open\(/);
  assert.match(await src('src/components/TimePickerField.web.tsx'), /type: 'time'/);
});

test('US spelling in the copy the app shows ("prioritizes", not "prioritises")', async () => {
  const sell = await src('src/content/sell.ts');
  assert.match(sell, /prioritizes and catches you/);
  const roots = ['src/content/sell.ts', 'src/components/intake/Reveal.tsx', 'app/settings/os.tsx', 'app/(tabs)/goals.tsx', 'app/(tabs)/today.tsx', 'app/(tabs)/apm.tsx'];
  for (const rel of roots) assert.doesNotMatch(await src(rel), /\b(prioritis|organis|stabilis|optimis|customis|behaviour|practis(e|ed|ing)\b|judgement|colour)/i, `${rel} uses US spelling`);
});

test('the express "Quick start or full setup" choice renders both options on the intake route', async () => {
  const intake = await src('app/intake.tsx');
  assert.match(intake, /screen\.kind === 'express'/);
  assert.match(intake, /label="Build my plan now"/);
  assert.match(intake, /label="Keep going"/);
});
