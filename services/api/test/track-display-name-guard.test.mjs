// Track 1 is only ever shown by its display name (@apm/domain TRACK_DISPLAY_NAMES). This walks
// every string literal and template piece in the Worker and package sources with the
// TypeScript parser: user-facing text may not say the retired "Billionaire Mindset".
// Comments and the internal key `billionaire_mindset` are fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

export function userFacingStrings(text, fileName) {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const strings = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return strings;
}

test('no user-facing string says "Billionaire Mindset"', async () => {
  const packages = (await readdir(join(root, 'packages'))).map((name) => join(root, 'packages', name, 'src'));
  const dirs = [join(root, 'services/api/src'), ...packages];
  const offenders = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const path of await sourceFiles(dir).catch(() => [])) {
      scanned += 1;
      for (const value of userFacingStrings(await readFile(path, 'utf8'), path)) if (/Billionaire Mindset/i.test(value)) offenders.push(`${path.replace(root, '')}: ${value.slice(0, 80)}`);
    }
  }
  assert.ok(scanned >= 40, `scanned ${scanned} files`);
  assert.deepEqual(offenders, []);
  // The guard sees through comments but not strings.
  assert.deepEqual(userFacingStrings("// Billionaire Mindset\nconst a = `x ${b} Billionaire Mindset`;", 'x.ts').filter((s) => /Billionaire Mindset/.test(s)), [' Billionaire Mindset']);
});
