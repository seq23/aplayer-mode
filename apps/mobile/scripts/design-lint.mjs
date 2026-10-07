#!/usr/bin/env node
// The design-system guard (the A Player Mode restyle, 7 Oct 2026). Fails (exit 1) when code
// outside src/theme writes its own colour or font, or a screen bypasses the primitives:
//   1. a raw colour literal ('#RRGGBB', rgb()/rgba()/hsl()) anywhere but src/theme;
//   2. a raw font family (fontFamily) anywhere but src/theme;
//   3. the token file imported directly (colours come from useTheme(), so dark mode works);
//   4. a screen (app/) with its own StyleSheet, inline style object, raw <Text>, <Pressable>
//      or <TextInput>; components outside ui.tsx with a raw <Pressable>/<TextInput>;
//   5. a control in the primitives (src/components/ui.tsx) without an accessibilityLabel;
//   6. allowFontScaling={false} anywhere (Dynamic Type must scale every text);
//   7. engineering words in what a person reads (docs/36): "Life Graph", "Personal OS",
//      "BHPC", "deterministic", "durable", "LLM", "execution state", "foreground", "Print my
//      agenda", "Priority execution", "opening step", "Plan step" in the screens, components,
//      content and billing code (comments and property names are not copy);
//   8. a raw thrown message shown to a person (`cause.message`): screens use plainError().
// Usage: node scripts/design-lint.mjs [appDir]   (default: this app)
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIMITIVES = 'src/components/ui.tsx';

/** Words a burnt-out parent should never have to read (docs/36). Lookarounds skip identifiers and `.foreground` properties. */
export const JARGON = [
  /Life Graph/i, /Personal OS/i, /\bBHPC\b/, /(?<![.\w$])deterministic(?![\w$])/i, /(?<![.\w$])durable(?![\w$])/i, /\bLLM\b/,
  /execution state/i, /(?<![.\w$'"])foreground(?![\w$:])/i, /Print my agenda/i, /Priority execution/i, /opening step/i, /\bPlan step\b/i,
];
/** Where copy lives (the API client, session and integrations hold codes and keys, not copy). */
const COPY_ROOTS = ['app/', 'src/components/', 'src/content/', 'src/billing/'];
/** Analytics values, never shown. */
const JARGON_ALLOWED = [/reason: 'deterministic'/];

/** The text minus comments, line numbers kept. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

async function sources(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...await sources(path)); }
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every opening <Tag …> in the text, as [index, openingTagText]. Tags end at the first "}>" or ">" after the last prop. */
function openingTags(text, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index);
    const end = Math.min(...['}>', '/>', '}\n>'].map((t) => { const i = rest.indexOf(t); return i < 0 ? Infinity : i; }));
    out.push([m.index, rest.slice(0, end === Infinity ? 400 : end)]);
  }
  return out;
}

export async function lintDesign(appDir) {
  const violations = [];
  const files = [...await sources(join(appDir, 'app')), ...await sources(join(appDir, 'src'))];
  if (files.length === 0) return { files: 0, violations: [`NO SOURCE FILES under ${appDir}/app or /src — refusing to pass on nothing.`] };
  for (const file of files) {
    const rel = relative(appDir, file).split('\\').join('/');
    const text = await readFile(file, 'utf8');
    const inTheme = rel.startsWith('src/theme/');
    const isScreen = rel.startsWith('app/');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      if (!inTheme && /['"`]#[0-9a-fA-F]{3,8}['"`]/.test(line)) violations.push(`${at} raw colour literal: use a theme token (useTheme().colors)`);
      if (!inTheme && /['"`](rgba?|hsla?)\(/.test(line)) violations.push(`${at} raw rgb()/hsl() colour: use a theme token`);
      if (!inTheme && /\bfontFamily\b/.test(line)) violations.push(`${at} raw font family: use the type scale (useTheme().type)`);
      if (!inTheme && /from\s+['"][^'"]*theme\/tokens['"]/.test(line)) violations.push(`${at} imports the token file directly: read colours through useTheme() so dark mode follows`);
      if (/allowFontScaling=\{false\}/.test(line)) violations.push(`${at} allowFontScaling={false}: Dynamic Type must scale every text`);
      if (isScreen && /StyleSheet\.create/.test(line)) violations.push(`${at} a screen with its own StyleSheet: build it from the primitives (src/components/ui.tsx)`);
      if (isScreen && /style=\{\{/.test(line)) violations.push(`${at} an inline style object in a screen: use a primitive`);
      if (isScreen && /<Text\b/.test(line)) violations.push(`${at} raw <Text> in a screen: use Body, Heading, Label… from the primitives`);
      if (rel !== PRIMITIVES && /<(Pressable|TextInput|TouchableOpacity|TouchableHighlight)\b/.test(line)) violations.push(`${at} raw control outside the primitives: use Button, Chip, AnswerCard, LinkButton, ListRow or TextField`);
    });
    if (COPY_ROOTS.some((root) => rel.startsWith(root))) {
      withoutComments(text).split('\n').forEach((line, i) => {
        if (JARGON_ALLOWED.some((ok) => ok.test(line))) return;
        const hit = JARGON.find((re) => re.test(line));
        if (hit) violations.push(`${rel}:${i + 1} engineering word in user copy (${hit.source}): say it in plain words (src/content/words.ts)`);
        if (/\b(cause|err|error)\.message\b/.test(line)) violations.push(`${rel}:${i + 1} raw error message shown to a person: use plainError(cause, '…')`);
      });
    }
    if (rel === PRIMITIVES) {
      for (const tag of ['Pressable', 'TextInput']) {
        for (const [index, opening] of openingTags(text, tag)) {
          if (!/accessibilityLabel=/.test(opening)) violations.push(`${rel}:${text.slice(0, index).split('\n').length} <${tag}> without an accessibilityLabel`);
        }
      }
    }
  }
  return { files: files.length, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  const { files, violations } = await lintDesign(appDir);
  if (violations.length) {
    console.error(`design-lint FAILED — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(`design-lint passed: ${files} files; colours and fonts only in src/theme, screens built from the primitives, every control labelled, plain words and plain errors in the copy.`);
}
