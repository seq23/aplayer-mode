// The code box after "Email me a 6-digit code" (src/components/intake/codeBox.ts): everyone types
// the 6-digit email code; the App Review account types the store-console code, which may be today's
// 6 digits or 12-24 letters and digits, the same rule the server checks (@apm/policy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'apm-review-code-box-'));
await build({ entryPoints: { codeBox: join(appDir, 'src/components/intake/codeBox.ts'), policy: join(appDir, '../../packages/policy/src/index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
const { codeBoxFor } = await import(pathToFileURL(join(outDir, 'codeBox.js')).href);
const policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
test.after(() => rm(outDir, { recursive: true, force: true }));
const src = (path) => readFile(join(appDir, path), 'utf8');

// Made-up fixture codes, never a real review code.
const SIXTEEN = 'q7Rt2Wx9Lm4Np8Zs';

test('everyone else: the 6-digit email code box is unchanged', () => {
  const box = codeBoxFor(false);
  assert.equal(box.keyboardType, 'number-pad');
  assert.equal(box.maxLength, 6);
  assert.equal(box.clean('12a3-45678'), '123456');
  assert.equal(box.ready('123456'), true);
  for (const code of ['12345', '', SIXTEEN, '1234567']) assert.equal(box.ready(code), false, code);
  assert.equal(box.label, '6-digit code');
  assert.match(box.lead('a@b.co'), /We sent a 6-digit code to a@b\.co/);
});

test('the review account: 6 digits and 12-24 letters and digits are accepted, 5, 11 and 25 are not, and the box can hold the longest', () => {
  const box = codeBoxFor(true);
  assert.equal(box.keyboardType, 'default', 'a code with letters needs the letter keyboard');
  assert.equal(box.maxLength, policy.REVIEW_CODE_MAX_LENGTH);
  assert.equal(box.maxLength, 24);
  for (const code of ['424242', 'Ab3dE6gH9jK2', SIXTEEN, 'a1B2c3D4e5F6g7H8i9J0k1L2']) {
    assert.equal(box.ready(box.clean(code)), true, code);
    assert.equal(policy.isReviewCodeShape(code), true, `server rule agrees: ${code}`);
  }
  for (const code of ['42424', 'Ab3dE6gH9jK', '1234567', '12345678']) {
    assert.equal(box.ready(code), false, code);
    assert.equal(policy.isReviewCodeShape(code), false, `server rule agrees: ${code}`);
  }
  assert.equal(box.clean(` ${SIXTEEN.slice(0, 8)}-${SIXTEEN.slice(8)} `), SIXTEEN, 'spaces and dashes from a pasted note are dropped');
  assert.equal(policy.isReviewCodeShape('a1B2c3D4e5F6g7H8i9J0k1L2m'), false, '25 characters are refused');
  assert.equal(box.clean('a1B2c3D4e5F6g7H8i9J0k1L2m').length, 24, 'the box never holds more than the server accepts');
  assert.equal(box.clean(SIXTEEN), SIXTEEN, 'letters keep their case');
  assert.doesNotMatch(box.lead('appreview@aplayermode.com'), /We sent/, 'no email is sent to this account, so the screen never says so');
});

test('both sign-in screens use the box the server chose, and keep no 6-digit-only check of their own', async () => {
  for (const path of ['src/components/intake/AccountPanel.tsx', 'app/billing/return.tsx']) {
    const screen = await src(path);
    assert.match(screen, /codeBoxFor\(review\)/, path);
    const sends = (screen.match(/sendEmailCode\(email\)/g) ?? []).length;
    assert.ok(sends >= 2, `${path}: send and resend`);
    assert.equal((screen.match(/setReview\(\(await sendEmailCode\(email\)\)\.review\)/g) ?? []).length, sends, `${path}: every send (and resend) takes the server's answer`);
    assert.match(screen, /box\.ready\(code\)/, path);
    assert.match(screen, /autoCapitalize="none" autoCorrect=\{false\}/, path);
    assert.doesNotMatch(screen, /code\.length (===|!==) 6/, path);
    assert.doesNotMatch(screen, /replace\(\/\\D\/g, ''\)\.slice\(0, 6\)/, path);
  }
  const session = await src('src/state/session.tsx');
  assert.match(session, /if \(\(await reviewerSignIn\(\{ email: address \}\)\)\?\.review\) \{ emailMode\.current = 'review'; return \{ review: true \}; \}/);
  assert.equal((session.match(/return \{ review: true \}/g) ?? []).length, 1, 'only the server-confirmed reviewer address gets the review box');
});
