#!/usr/bin/env node
// Proves an iOS upload really reached App Store Connect (Rule 0: a green `eas submit` is not proof).
// Reads the App Store Connect key that ios-store-build.yml wrote into apps/mobile/eas.json
// (submit.production.ios: ascApiKeyPath, ascApiKeyId, ascApiKeyIssuerId, ascAppId) and polls the
// builds list until this build number of this version is there, not INVALID. Never submits for review.
// usage: node scripts/asc-build-check.mjs <eas.json> <version> <buildNumber>
//        node scripts/asc-build-check.mjs --self-check   (proves the verdict on fixtures; no network)
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Verdict on a /v1/builds answer: 'found' | 'invalid' | 'absent'. */
export function buildVerdict(answer, buildNumber) {
  const hit = (answer?.data ?? []).find((b) => String(b.attributes?.version) === String(buildNumber));
  if (!hit) return 'absent';
  return hit.attributes?.processingState === 'INVALID' ? 'invalid' : 'found';
}

function token({ keyId, issuerId, p8 }) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  return `${unsigned}.${crypto.sign('sha256', Buffer.from(unsigned), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function selfCheck() {
  const cases = [
    [buildVerdict({ data: [{ attributes: { version: '12', processingState: 'PROCESSING' } }] }, 12) === 'found', 'a processing build counts'],
    [buildVerdict({ data: [{ attributes: { version: '12', processingState: 'INVALID' } }] }, 12) === 'invalid', 'an invalid build fails'],
    [buildVerdict({ data: [{ attributes: { version: '11', processingState: 'VALID' } }] }, 12) === 'absent', 'another build number is not this build'],
    [buildVerdict({}, 12) === 'absent', 'an empty answer is absent'],
  ];
  const bad = cases.filter(([ok]) => !ok).map(([, name]) => name);
  if (bad.length) { console.error(`asc-build-check self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
  console.log(`OUTPUT asc-build-check self-check: ${cases.length} fixtures behave`);
}

async function main([easJson, version, buildNumber]) {
  if (!easJson || !version || !/^\d+$/.test(buildNumber ?? '')) { console.error('usage: asc-build-check.mjs <eas.json> <version> <buildNumber>'); process.exit(2); }
  const ios = JSON.parse(await readFile(easJson, 'utf8')).submit?.production?.ios ?? {};
  if (!ios.ascApiKeyPath || !ios.ascApiKeyId || !ios.ascApiKeyIssuerId || !ios.ascAppId) { console.error('NAMED STOP [ASC_KEY_NOT_CONFIGURED] submit.production.ios lacks the App Store Connect key fields'); process.exit(1); }
  const p8 = await readFile(ios.ascApiKeyPath, 'utf8');
  const url = `https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${ios.ascAppId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[version]=${buildNumber}&limit=5`;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token({ keyId: ios.ascApiKeyId, issuerId: ios.ascApiKeyIssuerId, p8 })}` } });
    if (!res.ok) { console.error(`NAMED STOP [ASC_BUILDS_REFUSED] App Store Connect answered ${res.status}`); process.exit(1); }
    const verdict = buildVerdict(await res.json(), buildNumber);
    if (verdict === 'found') { console.log(`OUTPUT asc-build-check: ${version} (${buildNumber}) is in App Store Connect (app ${ios.ascAppId})`); return; }
    if (verdict === 'invalid') { console.error(`asc-build-check FAILED: ${version} (${buildNumber}) is INVALID in App Store Connect`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  console.error(`asc-build-check FAILED: ${version} (${buildNumber}) did not appear in App Store Connect within 15 minutes`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') selfCheck();
  else await main(process.argv.slice(2));
}
