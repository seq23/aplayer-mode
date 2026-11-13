// THE ONE GUARD of the free phone-app preview (.github/workflows/app-preview.yml). Two stages,
// both hard-fail with a NAMED STOP so the job can never go green having published nothing:
//
//   node scripts/preview/check.mjs export <dist>        before publishing
//     - the export holds every screen in app/ (zero routes, or one missing, fails);
//     - it is the PREVIEW build (the sample server is in the bundle), so it can open with no account;
//     - it carries no production endpoint and no key: the preview never reads or writes live data.
//   node scripts/preview/check.mjs served <url> <dist>  after publishing
//     - <url> answers with THIS build's page and its script, and a deep link opens the app.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const stop = (code, detail) => { console.error(`NAMED STOP [${code}] ${detail}`); process.exit(1); };
const [stage, first, second] = process.argv.slice(2);

function scripts(dist) {
  const page = join(dist, 'index.html');
  if (!existsSync(page)) stop('PREVIEW_NO_EXPORT', `${page} is missing`);
  const found = [...readFileSync(page, 'utf8').matchAll(/<script src="([^"]+\.js)"/g)].map((match) => match[1]);
  if (!found.length) stop('PREVIEW_NO_EXPORT', 'index.html loads no script');
  return found;
}
const walk = (dir) => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });

if (stage === 'export') {
  const dist = resolve(first ?? 'dist');
  const bundle = scripts(dist).map((src) => { const file = join(dist, src); if (!existsSync(file)) stop('PREVIEW_NO_EXPORT', `${src} is not in the export`); return readFileSync(file, 'utf8'); }).join('\n');
  const everything = walk(dist).filter((file) => /\.(js|html|json|map)$/.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
  // Every screen file under app/ is a route key in the exported bundle ("./settings/plan.tsx").
  const appDir = resolve(import.meta.dirname, '../../app');
  const wanted = walk(appDir).filter((file) => /\.tsx$/.test(file) && !/_layout\.tsx$/.test(file)).map((file) => `./${relative(appDir, file)}`);
  const exported = wanted.filter((route) => bundle.includes(`"${route}"`));
  if (!wanted.length || !exported.length) stop('PREVIEW_ZERO_ROUTES', `the export holds ${exported.length} of ${wanted.length} screens`);
  const missing = wanted.filter((route) => !exported.includes(route));
  if (missing.length) stop('PREVIEW_ROUTES_MISSING', `not in the export: ${missing.join(', ')}`);
  if (!everything.includes('preview/sample-account')) stop('PREVIEW_NOT_A_PREVIEW_BUILD', 'the sample server is not in the bundle (EXPO_PUBLIC_APM_PREVIEW=1 was not set at export)');
  const forbidden = [
    ['the production API address', /api\.aplayermode\.com/],
    ['a database project address', /[a-z0-9]{20}\.supabase\.co/],
    ['a database key', /sb_(publishable|secret)_[A-Za-z0-9_-]{8,}/],
    ['a signed token', /eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ['a store billing key', /\b(appl|goog|rcb|strp)_[A-Za-z0-9]{20,}/],
    ['a model provider key', /sk-(or|ant|proj)-[A-Za-z0-9_-]{16,}/],
  ].filter(([, pattern]) => pattern.test(everything)).map(([label]) => label);
  if (forbidden.length) stop('PREVIEW_HOLDS_LIVE_CONFIG', `the export contains ${forbidden.join(', ')}`);
  console.log(`OUTPUT preview export: ${exported.length} of ${wanted.length} screens, sample data only, no live endpoint or key`);
} else if (stage === 'served') {
  const url = (first ?? '').replace(/\/$/, '');
  const entry = scripts(resolve(second ?? 'dist')).at(-1);
  if (!/^https:\/\//.test(url)) stop('PREVIEW_NOT_SERVED', 'no published address to check');
  const get = async (path) => { try { const response = await fetch(`${url}${path}`, { redirect: 'follow', cache: 'no-store' }); return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }; } catch (cause) { return { status: 0, type: '', body: String(cause) }; } };
  let problem = '';
  // A fresh deployment can take a moment to reach the edge: up to 2 minutes, then a hard stop.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const page = await get('/');
    const deep = await get('/settings/plan');
    const script = await get(entry);
    problem = page.status !== 200 ? `the address answered ${page.status}`
      : !page.body.includes(entry) ? 'the address serves a different build (or not the app)'
      : deep.status !== 200 || !deep.body.includes(entry) ? `a deep link (/settings/plan) answered ${deep.status} without the app`
      : script.status !== 200 || !/javascript/.test(script.type) || script.body.length < 100_000 ? `the app's script answered ${script.status} (${script.type}, ${script.body.length} bytes)`
      : '';
    if (!problem) break;
    await new Promise((done) => setTimeout(done, 10_000));
  }
  if (problem) stop('PREVIEW_NOT_SERVED', `${url}: ${problem}`);
  console.log(`OUTPUT preview served: ${url} answers with this build (${entry.split('/').at(-1)})`);
} else {
  stop('PREVIEW_CHECK_USAGE', 'usage: check.mjs export <dist> | check.mjs served <url> <dist>');
}
