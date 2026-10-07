// Largest Dynamic Type (AX5, docs/36 A-5): every text carries its scale cap, and the two
// fixed boxes that held scaling text (the tab bar label, the Flow step number) no longer clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the tab label keeps its 1.4x cap inside the fixed-height tab bar', async () => {
  const layout = await src('app/(tabs)/_layout.tsx');
  assert.match(layout, /tabBarLabel: \(\{ color, children \}\) => <TabLabel color=\{color\}>/);
  assert.doesNotMatch(layout, /tabBarLabelStyle/, 'a bare label style drops the cap');
  const ui = await src('src/components/ui.tsx');
  assert.match(ui, /export function TabLabel[\s\S]{0,300}maxFontSizeMultiplier=\{maxFontSizeMultiplier\}/);
  const tokens = await src('src/theme/tokens.ts');
  assert.match(tokens, /tab: \{[^}]*maxScale: 1\.4 \}/);
});

test('no fixed width-and-height box wraps scaling text in the primitives', async () => {
  const ui = await src('src/components/ui.tsx');
  assert.match(ui, /num: \{ minWidth: 28, paddingVertical: 4,/, 'the Flow step number grows instead of clipping');
  // Every Text and TextInput in the primitives passes its cap through.
  for (const tag of ui.match(/<Text(Input)?\b[^>]*>/g) ?? []) assert.match(tag, /maxFontSizeMultiplier/, tag);
});
