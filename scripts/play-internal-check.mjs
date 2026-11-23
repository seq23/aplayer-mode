#!/usr/bin/env node
// Proves an Android upload really landed where android-store-build.yml says it did (Rule 0: a green
// `eas submit` is not proof). Reads Google Play's tracks through the Android Publisher API (an edit
// opened read-only and deleted) and fails unless THIS build's versionCode:
//   * is in a DRAFT release on the internal track, and
//   * is on no other track at all (production, open, closed incl. custom closed tracks, form factors).
// usage: node scripts/play-internal-check.mjs --key-file <service-account.json> <package> <versionCode>
//        node scripts/play-internal-check.mjs --self-check   (proves the verdict on fixtures; no network)
import { pathToFileURL } from 'node:url';
import { playAccessToken } from './lib/play-auth.mjs';

/** Problems with a tracks list for one versionCode; empty = fine. */
export function trackProblems(tracks, versionCode) {
  const code = String(versionCode);
  if (!/^\d+$/.test(code)) return [`versionCode ${JSON.stringify(versionCode)} is not a number`];
  const problems = [];
  const holds = (r) => (r.versionCodes ?? []).map(String).includes(code);
  const internal = (tracks ?? []).find((t) => t.track === 'internal');
  if (!internal) problems.push('no internal track returned (nothing was read)');
  const hit = (internal?.releases ?? []).find(holds);
  if (!hit) problems.push(`internal track has no release with versionCode ${code}`);
  else if (hit.status !== 'draft') problems.push(`internal release ${code} is "${hit.status}", not "draft"`);
  for (const t of tracks ?? []) {
    if (t.track === 'internal') continue;
    const elsewhere = (t.releases ?? []).filter(holds);
    if (elsewhere.length) problems.push(`versionCode ${code} is also on track "${t.track}" (${elsewhere.map((r) => r.status).join(', ')}): it may sit on internal only`);
  }
  return problems;
}

export async function readTracks(pkg, token, fetch = globalThis.fetch) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/edits`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const edit = await fetch(base, { method: 'POST', headers, body: '{}' });
  if (!edit.ok) throw new Error(`NAMED STOP [PLAY_EDIT_REFUSED] opening an edit on ${pkg} answered ${edit.status}`);
  const { id } = await edit.json();
  try {
    const res = await fetch(`${base}/${id}/tracks`, { headers });
    if (!res.ok) throw new Error(`NAMED STOP [PLAY_TRACKS_REFUSED] tracks.list answered ${res.status}`);
    return (await res.json()).tracks ?? [];
  } finally {
    // A failed cleanup never replaces the real result: an undeleted edit expires on its own.
    await Promise.resolve().then(() => fetch(`${base}/${id}`, { method: 'DELETE', headers }))
      .catch((err) => console.error(`note: edit ${id} not deleted (${err.message}); it expires on its own`));
  }
}

async function selfCheck() {
  const draft = [{ track: 'internal', releases: [{ status: 'draft', versionCodes: ['3'] }] }, { track: 'production', releases: [{ status: 'completed', versionCodes: ['2'] }] }, { track: 'beta' }];
  // A fake Play API: edit ok, then the given tracks answer; the DELETE always throws.
  const fakePlay = (tracksStatus) => async (url, init = {}) => {
    if (init.method === 'DELETE') throw new Error('network down');
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'e1' }));
    return new Response(JSON.stringify({ tracks: draft }), { status: tracksStatus });
  };
  const refused = await readTracks('com.example', 't', fakePlay(500)).then(() => 'no error', (err) => err.message);
  const readOk = await readTracks('com.example', 't', fakePlay(200)).then((t) => t.length, (err) => err.message);
  const cases = [
    [trackProblems(draft, 3).length === 0, 'a draft internal release passes (another build on production is not this build)'],
    [trackProblems(draft, 4).length === 1, 'a missing versionCode fails'],
    [trackProblems([{ track: 'internal', releases: [{ status: 'completed', versionCodes: ['3'] }] }], 3).length === 1, 'a live internal release fails'],
    [trackProblems([...draft, { track: 'production', releases: [{ status: 'draft', versionCodes: ['3'] }] }], 3).length === 1, 'this build on production fails'],
    [trackProblems([...draft, { track: 'Beta testers', releases: [{ status: 'inProgress', versionCodes: ['3'] }] }], 3).length === 1, 'this build on a custom closed track fails'],
    [trackProblems([...draft, { track: 'wear:internal', releases: [{ status: 'draft', versionCodes: ['3'] }] }], 3).length === 1, 'this build on a form-factor track fails'],
    [trackProblems([], 3).length > 0, 'an empty read fails'],
    [trackProblems(draft, '').length === 1, 'no versionCode fails'],
    [/PLAY_TRACKS_REFUSED/.test(refused), `the real error survives a failing edit delete (got: ${refused})`],
    [readOk === draft.length, `a good read survives a failing edit delete (got: ${readOk})`],
  ];
  const bad = cases.filter(([ok]) => !ok).map(([, name]) => name);
  if (bad.length) { console.error(`play-internal-check self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
  console.log(`OUTPUT play-internal-check self-check: ${cases.length} fixtures behave`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') await selfCheck();
  else {
    const [flag, keyFile, pkg, versionCode] = process.argv.slice(2);
    if (flag !== '--key-file' || !keyFile || !pkg || !versionCode) { console.error('usage: play-internal-check.mjs --key-file <sa.json> <package> <versionCode>'); process.exit(2); }
    try {
      const tracks = await readTracks(pkg, await playAccessToken(keyFile));
      const problems = trackProblems(tracks, versionCode);
      for (const t of tracks) console.log(`track ${t.track}: ${JSON.stringify((t.releases ?? []).map((r) => ({ status: r.status, versionCodes: r.versionCodes })))}`);
      if (problems.length) { console.error(`play-internal-check FAILED for ${pkg}:\n  ✗ ${problems.join('\n  ✗ ')}`); process.exit(1); }
      console.log(`OUTPUT play-internal-check: ${pkg} versionCode ${versionCode} is a draft on internal and on no other track (${tracks.length} tracks read)`);
    } catch (err) { console.error(err.message); process.exit(1); }
  }
}
