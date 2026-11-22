#!/usr/bin/env node
// Proves an Android upload really landed where android-store-build.yml says it did (Rule 0: a green
// `eas submit` is not proof). Reads Google Play's tracks through the Android Publisher API (an edit
// opened read-only and deleted) and fails unless:
//   * the internal track has a DRAFT release holding <versionCode>;
//   * production, closed (alpha) and open (beta) testing hold no release at all.
// usage: GOOGLE_PLAY_UPLOAD_SA_JSON=<json> node scripts/play-internal-check.mjs <package> <versionCode>
//        node scripts/play-internal-check.mjs --self-check   (proves the verdict on fixtures; no network)
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Problems with a tracks list for one versionCode; empty = fine. */
export function trackProblems(tracks, versionCode) {
  const problems = [];
  const code = String(versionCode);
  if (!/^\d+$/.test(code)) return [`versionCode ${JSON.stringify(versionCode)} is not a number`];
  const byName = new Map((tracks ?? []).map((t) => [t.track, t.releases ?? []]));
  if (!byName.has('internal')) problems.push('no internal track returned (nothing was read)');
  const internal = byName.get('internal') ?? [];
  const hit = internal.find((r) => (r.versionCodes ?? []).map(String).includes(code));
  if (!hit) problems.push(`internal track has no release with versionCode ${code}`);
  else if (hit.status !== 'draft') problems.push(`internal release ${code} is "${hit.status}", not "draft"`);
  for (const name of ['production', 'beta', 'alpha']) {
    const releases = byName.get(name) ?? [];
    if (releases.length) problems.push(`${name} track holds ${releases.length} release(s): nothing may leave internal from here`);
  }
  return problems;
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 600 })}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error(`NAMED STOP [PLAY_AUTH_FAILED] token request answered ${res.status}`);
  return (await res.json()).access_token;
}

async function readTracks(pkg, sa) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/edits`;
  const headers = { authorization: `Bearer ${await accessToken(sa)}`, 'content-type': 'application/json' };
  const edit = await fetch(base, { method: 'POST', headers, body: '{}' });
  if (!edit.ok) throw new Error(`NAMED STOP [PLAY_EDIT_REFUSED] opening an edit on ${pkg} answered ${edit.status}`);
  const { id } = await edit.json();
  try {
    const res = await fetch(`${base}/${id}/tracks`, { headers });
    if (!res.ok) throw new Error(`NAMED STOP [PLAY_TRACKS_REFUSED] tracks.list answered ${res.status}`);
    return (await res.json()).tracks ?? [];
  } finally {
    await fetch(`${base}/${id}`, { method: 'DELETE', headers });
  }
}

function selfCheck() {
  const draft = [{ track: 'internal', releases: [{ status: 'draft', versionCodes: ['3'] }] }, { track: 'production' }, { track: 'beta' }, { track: 'alpha' }];
  const cases = [
    [trackProblems(draft, 3).length === 0, 'a draft internal release passes'],
    [trackProblems(draft, 4).length === 1, 'a missing versionCode fails'],
    [trackProblems([{ track: 'internal', releases: [{ status: 'completed', versionCodes: ['3'] }] }], 3).length === 1, 'a live internal release fails'],
    [trackProblems([...draft, { track: 'production', releases: [{ status: 'draft', versionCodes: ['3'] }] }], 3).length === 1, 'anything on production fails'],
    [trackProblems([], 3).length > 0, 'an empty read fails'],
    [trackProblems(draft, '').length === 1, 'no versionCode fails'],
  ];
  const bad = cases.filter(([ok]) => !ok).map(([, name]) => name);
  if (bad.length) { console.error(`play-internal-check self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
  console.log(`OUTPUT play-internal-check self-check: ${cases.length} fixtures behave`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') selfCheck();
  else {
    const [pkg, versionCode] = process.argv.slice(2);
    if (!pkg || !versionCode) { console.error('usage: play-internal-check.mjs <package> <versionCode>'); process.exit(2); }
    if (!process.env.GOOGLE_PLAY_UPLOAD_SA_JSON) { console.error('NAMED STOP [GOOGLE_PLAY_UPLOAD_SA_JSON_MISSING]'); process.exit(1); }
    try {
      const tracks = await readTracks(pkg, JSON.parse(process.env.GOOGLE_PLAY_UPLOAD_SA_JSON));
      const problems = trackProblems(tracks, versionCode);
      for (const t of tracks) console.log(`track ${t.track}: ${JSON.stringify((t.releases ?? []).map((r) => ({ status: r.status, versionCodes: r.versionCodes })))}`);
      if (problems.length) { console.error(`play-internal-check FAILED for ${pkg}:\n  ✗ ${problems.join('\n  ✗ ')}`); process.exit(1); }
      console.log(`OUTPUT play-internal-check: ${pkg} versionCode ${versionCode} is a draft on internal; production, closed and open testing are empty`);
    } catch (err) { console.error(err.message); process.exit(1); }
  }
}
