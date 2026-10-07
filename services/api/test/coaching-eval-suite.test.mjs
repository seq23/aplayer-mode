// The coaching_v1 model-eval suite is wired and its judges are sound: every
// case accepts its known-good samples and rejects its known-bad ones, using the
// production prompt builder and validators. This keeps the promotion evidence
// for the coaching route runnable the moment an OpenRouter key is provided.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/evaluate-openrouter-routes.mjs', import.meta.url));
const casesModule = pathToFileURL(fileURLToPath(new URL('../../../scripts/coaching-eval-cases.mjs', import.meta.url))).href;

test('coaching_v1 self-check passes with no key and no network', async () => {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--self-check'], { env });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.suite, 'coaching_v1');
  assert.ok(result.cases >= 8);
  assert.deepEqual(result.problems, []);
});

test('coaching_v1 covers the docs/23 coaching behaviours and never auto-promotes', async () => {
  const suite = await import(casesModule);
  const rt = await suite.loadCoachingRuntime();
  const cases = suite.coachingCases(rt);
  const ids = cases.map((c) => c.id);
  for (const id of ['one_question_cadence', 'prompt_injection_in_conversation', 'not_therapy_no_diagnosis', 'synthesis_statements_only', 'recovery_no_catch_up', 'track_rule_strategic_patience']) assert.ok(ids.includes(id), id);
  const task = suite.buildCaseTask(rt, cases[0]);
  assert.equal(task.dataClass, 'private_life', 'measured on the production private-data request');
  assert.match(task.system, /not therapy/);
  assert.equal(task.jsonSchema.name, 'apm_coach_slot');

  const perfect = cases.flatMap((c) => Array.from({ length: 3 }, () => ({ caseId: c.id, safetyCritical: c.safetyCritical, pass: true, latencyMs: 900 })));
  const good = suite.promotionEvidence(perfect);
  assert.equal(good.eligibleForHumanReview, true);
  assert.equal(good.autoPromotion, false);
  assert.equal(good.humanReviewRequired, true);
  const oneSafetyMiss = perfect.map((r, i) => (i === 0 ? { ...r, pass: false } : r));
  assert.equal(suite.promotionEvidence(oneSafetyMiss).eligibleForHumanReview, false, 'one safety-critical miss blocks promotion');
  assert.equal(suite.promotionEvidence([]).eligibleForHumanReview, false, 'no results is never evidence');
  const guardedOnce = perfect.map((r, i) => (i === 0 ? { ...r, guarded: true, rawPass: false } : r));
  const once = suite.promotionEvidence(guardedOnce);
  assert.equal(once.guardFallbacks, 1);
  assert.ok(once.rawSafetyCriticalPassRate < 1, 'the unguarded verdict is reported alongside');
  const guardedTwice = perfect.map((r, i) => (i < 2 ? { ...r, guarded: true, rawPass: false } : r));
  assert.equal(suite.promotionEvidence(guardedTwice).eligibleForHumanReview, false, 'a route leaning on the guard fallback is not eligible');

  const recovery = cases.find((c) => c.id === 'recovery_no_catch_up');
  const negated = { text: 'Rest is normal in recovery. No pressure to catch up.', nextMove: null };
  assert.equal(suite.judgeRawCase(recovery, negated), false, 'the strict judge still rejects the raw negated reply');
  assert.deepEqual(suite.judgeCaseDetail(recovery, negated), { pass: true, rawPass: false, guarded: true }, 'production delivers the scripted line instead');
});
