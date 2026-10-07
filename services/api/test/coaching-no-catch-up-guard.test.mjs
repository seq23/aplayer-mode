// BHPC No Catch-Up output guard (docs/23 coaching review, 2026-10-06): a model
// reply with any "catch up" phrasing — even negated — never reaches the user;
// the scripted line is delivered instead, and the prompt tells the model the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir;
let coaching;
let machine;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-no-catch-up-'));
  await build({ entryPoints: { coaching: join(srcDir, 'coaching.ts'), machine: join(srcDir, 'coach/machine.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  coaching = await import(pathToFileURL(join(outDir, 'coaching.js')).href);
  machine = await import(pathToFileURL(join(outDir, 'machine.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const CAUGHT = [
  'No pressure to catch up.', 'No catch-up today.', 'There is no need for catching up.', 'You are caught up enough.',
  'Make up for it tomorrow.', 'Making up for lost time is not the goal.', 'Double up on Friday.', 'Do twice as much next week.',
  'Add extra sessions to compensate.', 'Schedule a make-up workout.', 'Catch-up debt is not a thing here.', 'CATCH UP later.',
];
const CLEAN = [
  'Today is one 10-minute walk. That counts as a win.', 'Missed sessions are data, not debt.', 'Make up your mind about the one move.',
  'Pick up where today starts.', 'The catcher made the play.', 'Set up the shoes by the door.',
];

test('hasCatchUpPhrasing catches every catch-up phrasing, negated or not, and nothing else', () => {
  for (const text of CAUGHT) assert.equal(machine.hasCatchUpPhrasing(text), true, text);
  for (const text of CLEAN) assert.equal(machine.hasCatchUpPhrasing(text), false, text);
  assert.equal(machine.hasCatchUpPhrasing(null), false);
});

const recoveryScripted = 'No catch-up and no evaluation today. You named “exhausted”. The smallest move that keeps continuity: Take a 10-minute walk.';

test('acceptModelSlot: a valid synthesis with catch-up phrasing is guarded to the scripted line and scripted next move', () => {
  const out = coaching.acceptModelSlot({ slot: 'synthesis', mode: 'recovery', text: 'Rest is normal in recovery. No pressure to catch up.', nextMove: 'Take a 10-minute walk', scripted: recoveryScripted, scriptedNextMove: 'Take a 10-minute walk' });
  assert.deepEqual(out, { accepted: false, guarded: true, text: recoveryScripted, nextMove: 'Take a 10-minute walk' });
});

test('acceptModelSlot: a catch-up question is guarded; a clean one is accepted', () => {
  const guarded = coaching.acceptModelSlot({ slot: 'question', mode: 'standard', text: 'What would help you catch up this week?', nextMove: null, scripted: 'What feels most stuck right now?' });
  assert.equal(guarded.guarded, true);
  assert.equal(guarded.text, 'What feels most stuck right now?');
  const clean = coaching.acceptModelSlot({ slot: 'question', mode: 'standard', text: ' What is the one move for today? ', nextMove: null, scripted: 'x?' });
  assert.deepEqual(clean, { accepted: true, guarded: false, text: 'What is the one move for today?', nextMove: undefined });
});

test('acceptModelSlot: a catch-up next move is dropped for the scripted one; format failures are not counted as guard trips', () => {
  const out = coaching.acceptModelSlot({ slot: 'synthesis', mode: 'standard', text: 'Confidence is blocking one send. Today is one pitch.', nextMove: 'Make up for the missed pitches', scripted: 's', scriptedNextMove: 'Send the pitch email to one editor' });
  assert.equal(out.accepted, true);
  assert.equal(out.nextMove, 'Send the pitch email to one editor');
  const invalid = coaching.acceptModelSlot({ slot: 'synthesis', mode: 'standard', text: 'Catch up? Maybe.', nextMove: null, scripted: 's' });
  assert.deepEqual([invalid.accepted, invalid.guarded], [false, false]);
});

test('every coaching prompt carries the No Catch-Up instruction, including negated forms', () => {
  for (const mode of ['standard', 'high_pressure', 'recovery', 'sprint', 'deep_work']) {
    for (const slot of ['question', 'synthesis']) {
      const task = coaching.buildCoachingSlotTask({ mode, slot, life: {}, scripted: 's', conversation: [] });
      assert.ok(task.system.includes(coaching.NO_CATCH_UP_INSTRUCTION), `${mode}/${slot}`);
    }
  }
  assert.match(coaching.NO_CATCH_UP_INSTRUCTION, /not even negated/);
  assert.match(coaching.NO_CATCH_UP_INSTRUCTION, /no pressure to catch up/);
  assert.match(coaching.NO_CATCH_UP_INSTRUCTION, /today/);
});
