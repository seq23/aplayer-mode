// @apm/privacy: every PrivacyDecision branch, the secret guard (names AND values) and the
// sensitivity classifier (engine P1-3, P1-4, P2-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let p; let outDir;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-privacy-'));
  await build({ entryPoints: { privacy: fileURLToPath(new URL('../src/index.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  p = await import(pathToFileURL(join(outDir, 'privacy.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const route = (over = {}) => ({ routeId: 'r', trainingAllowed: false, retention: 'zero', approvedForHighlySensitive: false, enabled: true, ...over });

test('every PrivacyDecision reason is reachable and fails closed', () => {
  assert.deepEqual(p.evaluateInferencePrivacy('private_life', route({ enabled: false })), { allowed: false, reason: 'route_disabled' });
  assert.deepEqual(p.evaluateInferencePrivacy('secret', route({ approvedForHighlySensitive: true })), { allowed: false, reason: 'secret_never_external' });
  for (const cls of ['low_personal', 'private_life', 'highly_sensitive']) {
    assert.deepEqual(p.evaluateInferencePrivacy(cls, route({ trainingAllowed: true })), { allowed: false, reason: 'training_not_allowed' }, cls);
  }
  assert.equal(p.evaluateInferencePrivacy('public_synthetic', route({ trainingAllowed: true, retention: 'unknown' })).allowed, true);
  for (const cls of ['private_life', 'highly_sensitive']) {
    for (const retention of ['limited', 'unknown']) assert.deepEqual(p.evaluateInferencePrivacy(cls, route({ retention })), { allowed: false, reason: 'zdr_required' });
  }
  assert.equal(p.evaluateInferencePrivacy('low_personal', route({ retention: 'limited' })).allowed, true);
  assert.deepEqual(p.evaluateInferencePrivacy('highly_sensitive', route()), { allowed: false, reason: 'highly_sensitive_not_approved' });
  assert.deepEqual(p.evaluateInferencePrivacy('highly_sensitive', route({ approvedForHighlySensitive: true })), { allowed: true, reason: 'allowed' });
  // The helpers ARE the rule (no second copy).
  assert.deepEqual(['public_synthetic', 'low_personal', 'private_life', 'highly_sensitive'].map(p.requiresZeroDataRetention), [false, false, true, true]);
  assert.deepEqual(['public_synthetic', 'low_personal', 'private_life'].map(p.mayUseTrainingEnabledRoute), [true, false, false]);
});

test('secret-named fields are refused anywhere in the context (the probe cases included)', () => {
  for (const context of [{ token: 'x' }, { authorization: 'Bearer abc' }, { idToken: 'x' }, { privateKey: 'x' }, { jwt: 'x' }, { cookie: 'x' },
    { nested: { refresh_token: 'x' } }, { list: [{ apiKey: 'x' }] }, { password: 'x' }, { sessionId: 'x' }, { otp: '123456' }]) {
    assert.throws(() => p.assertNoSecretKeysInObject(context), /Secret-like field/, JSON.stringify(context));
  }
  assert.doesNotThrow(() => p.assertNoSecretKeysInObject({ subject: 'Lunch', sourceText: 'See you at noon', mode: { name: 'Standard' } }));
});

test('credentials in text are found and redacted; the developer prompt may never carry one', () => {
  const body = 'Your API key is sk-or-v1-abc123 and password hunter2. Use Bearer abcdefghijklmnopqrstu to call. '
    + 'Code: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk. Your verification code is 482913. 551204 is your login code. '
    + 'ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP card 4111 1111 1111 1111.\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  const kinds = p.findSecrets(body);
  for (const kind of ['api_key', 'password_phrase', 'bearer', 'jwt', 'one_time_code', 'github_token', 'aws_access_key', 'payment_card', 'pem_private_key']) {
    assert.ok(kinds.includes(kind), kind);
  }
  const { text, redactions } = p.redactSecrets(body);
  assert.ok(redactions >= 9);
  for (const secret of ['sk-or-v1-abc123', 'hunter2', 'abcdefghijklmnopqrstu', 'eyJhbGci', '482913', '551204', 'ghp_', 'AKIA', '4111 1111', 'MIIabc']) {
    assert.ok(!text.includes(secret), secret);
  }
  // Ordinary numbers and words survive.
  assert.equal(p.redactSecrets('Meet at 10:30, room 4012, budget $1,250. Order 1234567890.').redactions, 0);

  const task = { system: 'You extract facts.', instruction: 'Extract commitments.', context: { subject: 'Reset', sourceText: 'Your password is hunter2' } };
  const guarded = p.guardInferenceText(task);
  assert.equal(guarded.task.context.sourceText, `Your ${p.REDACTED_SECRET}`);
  assert.equal(guarded.redactions, 1);
  assert.equal(task.context.sourceText, 'Your password is hunter2', 'input not mutated');
  assert.throws(() => p.guardInferenceText({ ...task, system: 'Use key sk-live_abcdef123456' }), /AI system/);
  assert.throws(() => p.guardInferenceText({ ...task, instruction: 'Bearer abcdefghijklmnopqrstuv' }), /AI instruction/);
  assert.throws(() => p.guardInferenceText({ ...task, context: { authorization: 'x' } }), /Secret-like field/);
});

test('health, financial, ID and child content is classified highly sensitive; the class is only ever raised', () => {
  for (const text of ['Your lab results are ready in the patient portal', 'Prescription refill for sertraline: medication pickup', 'Your bank statement for account ending in 4421',
    'Routing number 021000021', 'SSN 123-45-6789', 'Passport number on file', "Notes about my son's diagnosis and his IEP meeting", 'Your credit report changed']) {
    assert.equal(p.classifySensitivity([text]).highlySensitive, true, text);
    assert.equal(p.effectiveDataClass('private_life', [text]), 'highly_sensitive', text);
  }
  for (const text of ['Lunch with Sam on Friday', 'Ship the MVP to ten users', 'lose 30 lbs by spring', 'Swift code review at 3pm', 'Pick up the kids at 5']) {
    assert.equal(p.classifySensitivity([text]).highlySensitive, false, text);
    assert.equal(p.effectiveDataClass('private_life', [text]), 'private_life', text);
  }
  assert.equal(p.effectiveDataClass('secret', ['bank statement']), 'secret', 'never lowered');
  assert.equal(p.effectiveDataClass('low_personal', ['lab results']), 'highly_sensitive');
});
