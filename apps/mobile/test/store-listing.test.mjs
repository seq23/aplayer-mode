// The App Store listing (store/app-store.json) must fit Apple's field limits, or App Store Connect
// refuses it at submission: name and subtitle 30 characters, keywords 100 bytes, promotional text
// 170, description 4,000. No income or health promises (risk R-ADV-05, R-ADV-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const listing = JSON.parse(await readFile(new URL('../store/app-store.json', import.meta.url), 'utf8'));

export function listingProblems(l) {
  const out = [];
  for (const k of ['name', 'subtitle', 'keywords', 'promotionalText', 'description']) if (!l[k]) out.push(`${k} is empty`);
  if ([...(l.name || '')].length > 30) out.push('name over 30 characters');
  if ([...(l.subtitle || '')].length > 30) out.push('subtitle over 30 characters');
  if (Buffer.byteLength(l.keywords || '') > 100) out.push('keywords over 100 bytes');
  if ([...(l.promotionalText || '')].length > 170) out.push('promotional text over 170 characters');
  if ([...(l.description || '')].length > 4000) out.push('description over 4,000 characters');
  const all = `${l.subtitle} ${l.promotionalText} ${l.description}`;
  if (/\$\s?\d+k\b|make \$|lose \d+ ?(lb|kg|pounds)|guarantee(d)? (results|weight|income)/i.test(all)) out.push('income or health promise');
  return out;
}

test('the App Store listing fits Apple\'s limits and makes no income or health promise', () => {
  assert.deepEqual(listingProblems(listing), []);
});

test('the listing check fails on an over-long subtitle and an income promise (negative proof)', () => {
  const bad = listingProblems({ ...listing, subtitle: 'An AI chief of staff for your whole day', description: 'Make $10K a month.' });
  assert.ok(bad.includes('subtitle over 30 characters'));
  assert.ok(bad.includes('income or health promise'));
});
