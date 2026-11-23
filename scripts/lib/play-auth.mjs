#!/usr/bin/env node
// The ONE way the Play scripts sign in to the Android Publisher API (play-internal-check.mjs,
// play-billing-check.mjs): a service-account key file, exchanged for an access token by
// google-auth-library. Any failure (no file, bad JSON, bad key, Google refusing) is a NAMED STOP,
// never a token-less "pass".
// usage: node scripts/lib/play-auth.mjs --self-check   (proves the stops offline, and that no other script signs in by hand)
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JWT } from 'google-auth-library';

export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** An Android Publisher access token for the service account in `keyFile`. */
export async function playAccessToken(keyFile) {
  const text = await readFile(keyFile, 'utf8').catch(() => { throw new Error(`NAMED STOP [PLAY_KEY_FILE_MISSING] ${keyFile} not readable`); });
  let sa;
  try { sa = JSON.parse(text); } catch { throw new Error(`NAMED STOP [PLAY_KEY_FILE_INVALID] ${keyFile} is not JSON`); }
  if (!sa?.client_email || !sa?.private_key) throw new Error(`NAMED STOP [PLAY_KEY_FILE_INVALID] ${keyFile} has no client_email / private_key`);
  try {
    const { token } = await new JWT({ email: sa.client_email, key: sa.private_key, scopes: [PLAY_SCOPE] }).getAccessToken();
    if (!token) throw new Error('Google returned no access token');
    return token;
  } catch (err) {
    throw new Error(`NAMED STOP [PLAY_AUTH_FAILED] ${err.response?.status ? `token request answered ${err.response.status}` : err.message}`);
  }
}

async function selfCheck() {
  const dir = await mkdtemp(join(tmpdir(), 'apm-play-auth-'));
  const stop = (file) => playAccessToken(file).then(() => 'a token', (err) => err.message);
  try {
    await writeFile(join(dir, 'not-json.json'), 'nope');
    await writeFile(join(dir, 'no-key.json'), JSON.stringify({ client_email: 'fixture@example.invalid' }));
    await writeFile(join(dir, 'bad-key.json'), JSON.stringify({ client_email: 'fixture@example.invalid', private_key: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n' }));
    // Every script but this one: no hand-built Google sign-in (its token endpoint or JWT grant).
    const scriptsDir = fileURLToPath(new URL('../', import.meta.url));
    const handBuilt = [];
    for (const name of await readdir(scriptsDir)) {
      if (!name.endsWith('.mjs')) continue;
      const text = await readFile(join(scriptsDir, name), 'utf8');
      if (/oauth2\.googleapis\.com|jwt-bearer/.test(text)) handBuilt.push(name);
    }
    const cases = [
      [/PLAY_KEY_FILE_MISSING/.test(await stop(join(dir, 'absent.json'))), 'a missing key file is a named stop'],
      [/PLAY_KEY_FILE_INVALID/.test(await stop(join(dir, 'not-json.json'))), 'a key file that is not JSON is a named stop'],
      [/PLAY_KEY_FILE_INVALID/.test(await stop(join(dir, 'no-key.json'))), 'a key file with no private key is a named stop'],
      [/PLAY_AUTH_FAILED/.test(await stop(join(dir, 'bad-key.json'))), 'a key that cannot sign is a named stop, never a token'],
      [handBuilt.length === 0, `no script signs in to Google by hand (found: ${handBuilt.join(', ') || 'none'})`],
    ];
    const bad = cases.filter(([ok]) => !ok).map(([, name]) => name);
    if (bad.length) { console.error(`play-auth self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
    console.log(`OUTPUT play-auth self-check: ${cases.length} fixtures behave`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') await selfCheck();
  else { console.error('usage: node scripts/lib/play-auth.mjs --self-check'); process.exit(2); }
}
