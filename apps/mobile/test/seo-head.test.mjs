// The app host (app.aplayermode.com) carries description, canonical and social tags, and keeps
// sign-up, account, billing and signed-in routes out of search (the marketing site is aplayermode.com).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { addSeoHead, DESCRIPTION, OG_IMAGE } from '../scripts/seo-head.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(appDir, path), 'utf8');
const EXPO_HEAD = '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>A Player Mode</title></head><body></body></html>';

test('built HTML: description, canonical, Open Graph and Twitter tags', () => {
  const html = addSeoHead(EXPO_HEAD);
  assert.ok(DESCRIPTION.length <= 160, `description is ${DESCRIPTION.length} chars`);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(`<meta name="description" content="${DESCRIPTION}">`));
  assert.ok(head.includes('<link rel="canonical" href="https://app.aplayermode.com/">'));
  assert.ok(head.includes('<meta property="og:type" content="website">'));
  assert.ok(head.includes('<meta property="og:site_name" content="A Player Mode">'));
  assert.ok(head.includes('<meta property="og:title" content="A Player Mode">'));
  assert.ok(head.includes(`<meta property="og:description" content="${DESCRIPTION}">`));
  assert.ok(head.includes('<meta property="og:url" content="https://app.aplayermode.com/">'));
  assert.ok(head.includes('<meta property="og:image" content="https://app.aplayermode.com/icons/icon-512.png">'));
  assert.ok(head.includes('<meta name="twitter:card" content="summary">'));
  assert.doesNotMatch(head, /name="robots"/, 'the shared HTML never carries noindex: "/" stays indexable');
  assert.equal(addSeoHead(html), html, 'idempotent');
  assert.equal(OG_IMAGE.replace('https://app.aplayermode.com/', ''), 'icons/icon-512.png');
});

test('og:image is a real file the web build serves', async () => {
  const png = await readFile(join(appDir, 'public/icons/icon-512.png'));
  assert.equal(png.readUInt32BE(16), 512);
});

test('the production web deploy runs seo-head and refuses without the canonical', async () => {
  const deploy = await read('../../scripts/deploy-web-production.sh');
  assert.match(deploy, /node scripts\/seo-head\.mjs dist\/index\.html/);
  assert.match(deploy, /rel="canonical" href="https:\/\/app\.aplayermode\.com\/".*exit 1/);
  assert.ok(deploy.indexOf('seo-head.mjs') < deploy.indexOf('wrangler deploy'));
});

test('route-level robots: "/" indexable, sign-up/account/billing/signed-in routes noindex', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'apm-robots-'));
  try {
    await build({ entryPoints: { robots: join(appDir, 'src/web/robots.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
    const { isIndexable, applyRobots, NOINDEX } = await import(pathToFileURL(join(outDir, 'robots.js')).href);
    for (const path of ['/', '', null, '/?ref=x', '/welcome']) assert.equal(isIndexable(path), true, String(path));
    for (const path of ['/join', '/account', '/billing/return', '/billing/return?x=1', '/settings', '/settings/plan', '/settings/privacy/data', '/intake', '/age', '/health-consent', '/today', '/radar', '/radar/why', '/goals', '/apm', '/diary', '/review', '/some-new-route']) {
      assert.equal(isIndexable(path), false, path);
    }
    // A fake document: noindex added on /join, updated not duplicated, removed back on "/".
    const nodes = [];
    const doc = {
      createElement: () => { const el = { attrs: {}, setAttribute(n, v) { this.attrs[n] = v; }, remove() { nodes.splice(nodes.indexOf(el), 1); } }; return el; },
      head: { appendChild: (el) => nodes.push(el), querySelector: () => nodes.find((n) => n.attrs.name === 'robots') ?? null },
    };
    applyRobots('/join', doc);
    applyRobots('/billing/return', doc);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].attrs.content, NOINDEX);
    assert.equal(NOINDEX, 'noindex, nofollow');
    applyRobots('/', doc);
    assert.equal(nodes.length, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /applyRobots\(pathname, document/);
  assert.match(layout, /\[pathname\]/);
});

test('non-JS crawlers: account/sign-up/billing paths carry X-Robots-Tag noindex', async () => {
  const headers = await read('public/_headers');
  for (const path of ['/join', '/account', '/billing/*', '/settings/*', '/intake', '/age', '/health-consent']) {
    assert.match(headers, new RegExp(`^${path.replace(/[*/]/g, '\\$&')}\\n  X-Robots-Tag: noindex, nofollow$`, 'm'), path);
  }
  assert.doesNotMatch(headers, /^\/\n  X-Robots-Tag/m);
});
