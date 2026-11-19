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

// Google Play (store/google-play.json): title 30, short 80, full 4,000; no income or health promise;
// and the account-deletion URL Google requires (Play Help 13327111) is a real page shipped with the
// web app, saying how to ask without the app, what is deleted, what is kept and how long it takes.
const play = JSON.parse(await readFile(new URL('../store/google-play.json', import.meta.url), 'utf8'));
export function playProblems(p) {
  const out = [];
  if (!p.title || [...p.title].length > 30) out.push('title empty or over 30 characters');
  if (!p.shortDescription || [...p.shortDescription].length > 80) out.push('short description empty or over 80 characters');
  if (!p.fullDescription || [...p.fullDescription].length > 4000) out.push('full description empty or over 4,000 characters');
  if (/\$\s?\d+k\b|make \$|lose \d+ ?(lb|kg|pounds)|guarantee(d)? (results|weight|income)/i.test(`${p.shortDescription} ${p.fullDescription}`)) out.push('income or health promise');
  if (/#\w/.test(`${p.shortDescription} ${p.fullDescription}`)) out.push('hashtag');
  return out;
}

test('the Google Play listing fits Google\'s limits and makes no promise', () => {
  assert.deepEqual(playProblems(play), []);
  assert.ok(playProblems({ ...play, shortDescription: 'x'.repeat(81), fullDescription: 'Make $10K a month. #hustle' }).length === 3, 'negative proof');
});

test('the Play account-deletion URL is a real static page, not the app\'s catch-all route', async () => {
  const url = new URL(play.accountDeletionUrl);
  assert.equal(url.host, 'app.aplayermode.com');
  const html = await readFile(new URL(`../public${url.pathname}/index.html`, import.meta.url), 'utf8');
  for (const part of ['support@aplayermode.com', 'What is deleted', 'What is kept', 'How long it takes', '/settings/privacy/export-delete']) assert.ok(html.includes(part), `delete-account page lacks ${part}`);
});
