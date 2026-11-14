import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, renameSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Cloudflare Pages never uploads a folder named node_modules, and Expo's web export puts every
// bundled font and picture under assets/node_modules/. On 10 Nov 2026 that left the preview a
// blank page: the fonts answered with the home page, so the app never drew. Move the folder to
// assets/nm and point the bundles at it. Returns how many files were rewritten.
export function moveBundledAssets(directory) {
  const from = resolve(directory, 'assets', 'node_modules');
  if (!existsSync(from)) return 0;
  renameSync(from, resolve(directory, 'assets', 'nm'));
  let changed = 0;
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(js|html|json|map)$/.test(name)) { const text = readFileSync(path, 'utf8'); if (text.includes('/assets/node_modules/')) { writeFileSync(path, text.replaceAll('/assets/node_modules/', '/assets/nm/')); changed++; } } } };
  walk(resolve(directory));
  return changed;
}

export function publish({ project, branch, directory = 'dist', env = process.env, run = spawnSync }) {
  // Every stop names the step and carries wrangler's last lines: a bare stop hid why it failed (14 Nov 2026).
  const tail = (r) => r ? `\n  exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}${r.error ? ` (${r.error.message})` : ''}\n${`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n')}` : '';
  const stop = (step, r) => { throw new Error(`NAMED STOP [PREVIEW_HOST_FAILED] ${step}${tail(r)}`); };
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !branch || !existsSync(resolve(directory, 'index.html'))) stop('missing token, account, branch or export');
  moveBundledAssets(directory);
  writeFileSync(resolve(directory, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n');
  writeFileSync(resolve(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  const invoke = (args) => run('npx', ['--yes', 'wrangler@4.110.0', 'pages', ...args], { env: { ...env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 120000 });
  const list = invoke(['project', 'list', '--json']);
  if (list.status !== 0) stop('project list', list);
  let projects;
  try { projects = JSON.parse(list.stdout); } catch { stop('project list is not JSON', list); }
  if (!Array.isArray(projects)) stop('project list is not a list', list);
  if (!projects.some(p => p.name === project || p['Project Name'] === project)) {
    const created = invoke(['project', 'create', project, '--production-branch', 'main']);
    if (created.status !== 0) stop('project create', created);
  }
  const deployed = invoke(['deploy', directory, '--project-name', project, '--branch', branch]);
  if (deployed.status !== 0) stop('deploy', deployed);
  // Wrangler 4.110 can exit zero with an unconfirmed status and a URL.
  // Only its confirmed-success branch emits this result line.
  const confirmed = (deployed.stdout ?? '').match(/Deployment complete! Take a peek over at (https:\/\/[a-z0-9.-]+\.pages\.dev)\b/);
  if (!confirmed) stop('deploy not confirmed', deployed);
  const urls = confirmed[1].match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev\b/g) ?? [];
  const url = urls.find(value => new URL(value).hostname.endsWith('.' + project + '.pages.dev'));
  if (!url) stop('no preview URL for this project', deployed);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `[Open the phone app preview](${url})\n\nFree web preview. No Appetize minutes.\n`);
  return url;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { console.log(publish({ project: process.argv[2], branch: process.env.PREVIEW_BRANCH })); }
  catch (error) { console.error(error instanceof Error ? error.message : 'NAMED STOP [PREVIEW_HOST_FAILED]'); process.exitCode = 1; }
}
