// The first-run intake (docs/34): bank, gates, path, quick start, persistence (state layer),
// the deterministic synthesis, the three pillars with areas, the in-bed routine and the Mind
// and Spirit practice libraries. Everything runs on the device; these tests are the build's
// acceptance tests AT1, AT2, AT4-AT6, AT8, AT9, AT10, AT14 at the state layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_QUESTIONS,
  BED_ROUTINE,
  BED_ROUTINE_GENTLE,
  BED_ROUTINE_STEP,
  FLOOR_CHIPS,
  GOAL_TEMPLATES,
  HEALTH_DATA_GOAL_IDS,
  HEALTH_DATA_QUESTION_IDS,
  JOURNAL_PROMPTS,
  MEDITATION_SCRIPTS,
  MIND_PRACTICES,
  REVEAL_SCREENS,
  SCREEN_PLATES,
  SECTIONS,
  SPIRIT_PRACTICES,
  answered,
  classifySuggestedArea,
  coachingModeChips,
  deferredForToday,
  emptyDraft,
  formatPillarRollUp,
  generateBedRoutine,
  generatePractices,
  goalText,
  mergeDrafts,
  moveSuggestedArea,
  options,
  parseDraft,
  path,
  prefillFor,
  questionById,
  questionPath,
  recognizePersona,
  registry,
  requiredOk,
  requiredReason,
  resolveDeepLink,
  resumeCursor,
  rollUpPillars,
  setDraftAnswer,
  setDraftCursor,
  stepScreen,
  supplyDailyActions,
  synthesizeProfile,
  toInstallPayload,
  toggleOption,
  validatePlan,
  visibleAnswers,
  withoutHealthAnswers,
} from '../.test-dist/index.js';

const START = '2026-10-05';

/** Walks the intake like a user: answers every on-path question, then continues. */
function walk(script, mode = 'full', { stopAt } = {}) {
  let draft = emptyDraft(1);
  // The health-data choice is made before the questions (its own screen); '_health' mirrors it.
  if ('_health' in script) draft = setDraftAnswer(draft, '_health', script._health, 1);
  let now = 2;
  let cursor = 'games';
  const seen = [];
  const set = (id, value) => { draft = setDraftAnswer(draft, id, value, now++); };
  for (let guard = 0; guard < 200; guard += 1) {
    const screen = registry(draft.answers, mode).find((s) => s.id === cursor);
    seen.push(cursor);
    if (cursor === stopAt) break;
    if (screen.kind === 'question') {
      const q = screen.question;
      const pf = prefillFor(q, draft.answers, synthesizeProfile(draft.answers, { startDate: START }).tracks.some((t) => t.key === 'billionaire_mindset'));
      if (pf) for (const [k, v] of Object.entries(pf)) { draft = { ...draft, answers: { ...draft.answers, [k]: v } }; }
      if (q.id in script) set(q.id, script[q.id]);
      else if (draft.answers[q.id] === undefined) {
        const opts = options(q, draft.answers);
        if (q.type === 'single') set(q.id, opts[0][0]);
        else if (q.type === 'multi' || q.type === 'weekdays') { if (!q.optional) set(q.id, [opts[0][0]]); }
        else if (q.type === 'rank') set(q.id, opts.map(([v]) => v));
        else if (q.type === 'yesno') set(q.id, false);
        else if (q.type === 'slider' || q.type === 'time') set(q.id, q.def ?? 5);
      }
      assert.ok(requiredOk(q, draft.answers), `${q.id} answerable`);
    }
    if (screen.kind === 'express') set('mode', mode);
    if (screen.kind === 'plan') break;
    const next = stepScreen(draft.answers, cursor, 1, mode);
    if (next === cursor) break;
    cursor = next;
  }
  return { draft, seen, questions: seen.filter((id) => questionById(id)) };
}

// Every persona here gave the consumer health data consent; the no-consent path has its own tests.
const PERSONAS = {
  weight: { _health: 'yes', games: ['weight'], goal: 'lose_weight', clinician_flag: 'no' },
  wealth: { _health: 'yes', games: ['wealth'], goal: 'emergency_fund' },
  founder: { _health: 'yes', games: ['founder'], goal: 'customers', equity: true },
  operator: { _health: 'yes', games: ['operator'], goal: 'promotion' },
  parentPlus: { _health: 'yes', games: ['parent', 'founder'], foreground: 'founder', goal: 'customers' },
};

test('the bank: every question has a plate line, a field and a BHPC mapping; ids are unique (AT10, AT11)', () => {
  assert.ok(ALL_QUESTIONS.length >= 69, `bank has ${ALL_QUESTIONS.length} questions`);
  const ids = ALL_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const q of ALL_QUESTIONS) {
    assert.ok(q.plate.trim().length > 10, `${q.id} plate`);
    assert.ok(q.field && q.bhpc && q.why, `${q.id} metadata`);
  }
  for (const section of SECTIONS) if (section.after) assert.ok(section.after.plate.length > 10, section.after.id);
  for (const screen of REVEAL_SCREENS) assert.ok(SCREEN_PLATES[screen.id], `${screen.id} has a plate`);
  for (const id of ['welcome', 'acct', 'express', 'today']) assert.ok(SCREEN_PLATES[id], id);
  assert.ok(registry({}).length > 0, 'the registry is never empty');
});

test('paywall position: the plan choice comes after the OS summary and before Day 1, on every path', () => {
  assert.deepEqual(REVEAL_SCREENS.map((s) => s.id), ['building', 'summary', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'plan']);
  for (const persona of Object.values(PERSONAS)) {
    for (const mode of ['full', 'quick']) {
      const seen = walk(persona, mode).seen;
      assert.equal(seen.at(-1), 'plan', 'the paywall is the last setup screen (Today follows it)');
      assert.equal(seen.at(-2), 'summary', 'straight after the summary');
      assert.ok(!seen.some((id) => /^r[1-6]$/.test(id)), 'detail screens are opened from the summary, never stepped through');
    }
  }
});

test('the morning section opens with the bed question, asked of everyone (quick start too)', () => {
  const s12 = SECTIONS.find((s) => s.id === 's12');
  assert.equal(s12.questions[0].id, 'bed');
  assert.equal(questionById('bed').title, 'Is getting out of bed hard for you?');
  assert.equal(questionById('bed').gate, undefined);
  assert.equal(questionById('bed').essential, true);
  for (const persona of Object.values(PERSONAS)) assert.ok(walk(persona, 'quick').questions.includes('bed'));
});

test('Mind and Spirit are separate sections; "What feeds your spirit?" is one tap and gated on the Spirit pillar', () => {
  const names = SECTIONS.map((s) => s.name);
  assert.ok(names.includes('Mind') && names.includes('Spirit') && !names.includes('Mind & learning'));
  const spirit = questionById('spirit');
  assert.equal(spirit.type, 'multi');
  assert.equal(spirit.title, 'What feeds your spirit?');
  assert.deepEqual(spirit.options.map(([v]) => v), ['faith', 'meditation', 'gratitude', 'nature', 'service', 'none']);
  assert.ok(path({ games: ['founder'] }).some((s) => s.id === 'spirit'));
  assert.ok(!path({ games: ['founder'], core_pillars: ['mind', 'body'] }).some((s) => s.id === 'spirit'), 'opted out of Spirit → not asked');
});

test('gating per persona: only the sections that apply are shown', () => {
  const ids = (persona) => walk(persona).questions;
  assert.ok(ids(PERSONAS.weight).includes('clinician_flag') && ids(PERSONAS.weight).includes('weigh_in'));
  assert.ok(!ids(PERSONAS.weight).includes('income'), 'no Work & money for a pure weight-loss game');
  assert.ok(!ids(PERSONAS.founder).includes('clinician_flag'), 'body safety only for weight loss');
  assert.ok(ids(PERSONAS.founder).includes('equity') && ids(PERSONAS.founder).includes('real_work'));
  assert.ok(!ids(PERSONAS.wealth).includes('real_work'), 'real/fake work only for founder, operator, creator');
  assert.ok(ids(PERSONAS.wealth).includes('money_state'));
  assert.ok(ids(PERSONAS.operator).includes('career_lever'));
  assert.ok(ids(PERSONAS.parentPlus).includes('dependents') && ids(PERSONAS.parentPlus).includes('foreground'));
  assert.ok(!ids(PERSONAS.founder).includes('dependents'));
  assert.ok(!ids(PERSONAS.founder).includes('foreground'), 'one game → no foreground question');
});

test('question counts per path stay inside the published ranges (docs/34 §4.4)', () => {
  const counts = {};
  for (const [name, persona] of Object.entries(PERSONAS)) counts[name] = { full: walk(persona).questions.length, quick: walk(persona, 'quick').questions.length };
  for (const [name, c] of Object.entries(counts)) {
    assert.ok(c.full >= 39 && c.full <= 70, `${name} full ${c.full}`);
    assert.ok(c.quick >= 18 && c.quick <= 23, `${name} quick ${c.quick}`);
  }
});

test('quick start: essentials only, then straight to Building your OS; the rest wait on Today, 2 a day (AT14)', () => {
  const quick = walk(PERSONAS.weight, 'quick');
  const afterExpress = quick.seen.slice(quick.seen.indexOf('express') + 1);
  for (const id of afterExpress.filter((x) => questionById(x))) assert.equal(questionById(id).essential, true, `${id} is essential`);
  assert.ok(afterExpress.includes('clinician_flag'), 'weight loss still asks the body safety question');
  assert.ok(afterExpress.includes('tone') && afterExpress.includes('floors'));
  assert.ok(!afterExpress.some((id) => /^i[3-5]$/.test(id)), 'no interstitials after the choice');
  assert.equal(afterExpress.at(-1), 'plan');
  const deferred = deferredForToday(quick.draft.answers, { dayNumber: 2, lightDay: false, askedToday: 0 });
  assert.equal(deferred.length, 2);
  assert.deepEqual(deferredForToday(quick.draft.answers, { dayNumber: 1, lightDay: false, askedToday: 0 }), [], 'never on Day 1');
  assert.deepEqual(deferredForToday(quick.draft.answers, { dayNumber: 3, lightDay: true, askedToday: 0 }), [], 'never on a light day');
  assert.equal(deferredForToday(quick.draft.answers, { dayNumber: 3, lightDay: false, askedToday: 1 }).length, 1, 'never more than 2 a day');
  const payload = toInstallPayload(quick.draft.answers, { startDate: START, draftVersion: quick.draft.version });
  assert.equal(payload.intakeProfile.quickStart, true);
  assert.ok(payload.intakeProfile.deferredQuestionIds.length > 10);
});

test('AT1: answer Q1 to Q10, Back 5 times, Continue 5 times: every answer is still there', () => {
  const full = walk(PERSONAS.founder);
  const tenIds = full.questions.slice(0, 10);
  const run = walk(PERSONAS.founder, 'full', { stopAt: full.questions[10] });
  const draft = run.draft;
  assert.equal(answered(questionById(full.questions[10]), draft.answers), false, 'stopped before Q11');
  let cursor = tenIds.at(-1);
  for (let i = 0; i < 5; i += 1) cursor = stepScreen(draft.answers, cursor, -1);
  for (let i = 0; i < 5; i += 1) cursor = stepScreen(draft.answers, cursor, 1);
  assert.equal(cursor, tenIds.at(-1));
  for (const id of tenIds) assert.ok(answered(questionById(id), draft.answers), `${id} kept`);
});

test('AT2: kill and relaunch: the stored draft resumes at its cursor with every answer', () => {
  let draft = walk(PERSONAS.weight, 'full', { stopAt: 'fixed' }).draft;
  draft = setDraftCursor(draft, 'fixed', 99);
  const restored = parseDraft(JSON.parse(JSON.stringify(draft)), 100);
  assert.equal(restored.cursor, 'fixed');
  assert.deepEqual(restored.answers, draft.answers);
  // Without a stored cursor: the first unanswered required question.
  const { cursor, ...noCursor } = draft;
  void cursor;
  assert.equal(parseDraft({ ...noCursor, cursor: '' }, 100).cursor, resumeCursor(draft.answers));
  assert.equal(parseDraft('garbage', 5).version, 0, 'malformed storage starts fresh, never crashes');
});

test('AT4/AT6: offline answers and a second device merge per question, newest wins, nothing duplicated', () => {
  const base = setDraftAnswer(setDraftAnswer(emptyDraft(1), 'games', ['founder'], 10), 'season', 'building', 11);
  const phone = setDraftAnswer(setDraftAnswer(base, 'season', 'launching', 20), 'load', 8, 21);
  const server = setDraftAnswer(base, 'carry', ['deadlines'], 15);
  const merged = mergeDrafts(server, phone);
  assert.deepEqual(merged.answers, { games: ['founder'], season: 'launching', load: 8, carry: ['deadlines'] });
  assert.ok(merged.version > Math.max(phone.version, server.version));
  assert.deepEqual(mergeDrafts(merged, merged).answers, merged.answers, 'idempotent');
  const stale = setDraftAnswer(base, 'season', 'recovering', 12);
  assert.equal(mergeDrafts(phone, stale).answers.season, 'launching', 'an older write never overwrites a newer one');
});

test('AT5: untick a game and its answers are kept but not installed; tick it again and they come back', () => {
  const { draft } = walk(PERSONAS.parentPlus);
  assert.ok(draft.answers.dependents);
  const without = setDraftAnswer(draft, 'games', ['founder'], 999);
  assert.ok(without.answers.dependents, 'kept in the draft');
  assert.equal(visibleAnswers(without.answers).dependents, undefined, 'not sent at install');
  assert.equal(toInstallPayload(without.answers, { startDate: START, draftVersion: 1 }).intakeProfile.family, undefined);
  const again = setDraftAnswer(without, 'games', ['parent', 'founder'], 1000);
  assert.deepEqual(visibleAnswers(again.answers).dependents, draft.answers.dependents);
});

test('AT9: a required question with nothing selected blocks Continue and says why', () => {
  const games = questionById('games');
  assert.equal(requiredOk(games, {}), false);
  assert.equal(requiredReason(games, {}), 'Answer this one to continue.');
  assert.equal(requiredOk(questionById('patterns'), {}), true, 'optional questions can be skipped');
  const exclusive = questionById('deadlines');
  assert.deepEqual(toggleOption(exclusive, { deadlines: ['exam'] }, 'none'), ['none']);
  assert.deepEqual(toggleOption(exclusive, { deadlines: ['none'] }, 'exam'), ['exam']);
  assert.equal(toggleOption(questionById('values'), { values: ['integrity', 'family', 'freedom', 'health', 'faith'] }, 'peace').length, 5, 'max 5 values');
});

test('deep links to a hidden question go to the cursor', () => {
  assert.equal(resolveDeepLink({ games: ['founder'] }, 'dependents', 'season'), 'season');
  assert.equal(resolveDeepLink({ games: ['parent'] }, 'dependents', 'season'), 'dependents');
});

test('changing an earlier answer re-evaluates gates; a gated-out cursor moves to the nearest screen', () => {
  const a = { games: ['parent', 'founder'], foreground: 'founder' };
  assert.equal(stepScreen({ games: ['founder'] }, 'dependents', 1), stepScreen({ games: ['founder'] }, 'dependents', 1));
  const next = stepScreen({ ...a, games: ['founder'] }, 'dependents', 1);
  assert.ok(path({ ...a, games: ['founder'] }).some((s) => s.id === next));
});

test('every goal template becomes text that the plan engine recognises for its game', () => {
  const expected = { weight: 'weight_loss', wealth: 'wealth_building', founder: 'founder', operator: 'operator_promotion' };
  for (const [game, persona] of Object.entries(expected)) {
    for (const goal of GOAL_TEMPLATES[game]) {
      const text = goalText({ games: [game], goal: goal.id });
      const roles = [{ weight: 'Losing weight / getting healthy', wealth: 'Building wealth', founder: 'Founder / entrepreneur', operator: 'Operator: moving up at a company' }[game]];
      assert.equal(recognizePersona(text, roles).foregroundPersona, persona, `${game}/${goal.id}: "${text}"`);
    }
  }
  for (const goal of GOAL_TEMPLATES.parent) assert.equal(recognizePersona(goalText({ games: ['parent'], goal: goal.id }), ['Parent / caregiver']).key, 'parent_plus');
});

test('High-Pressure Coaching is pre-selected when the Billionaire High Performance Coach Track is suggested, and can be changed', () => {
  const tone = questionById('tone');
  const founder = { games: ['founder'] };
  const synthesis = synthesizeProfile(founder, { startDate: START });
  assert.ok(synthesis.tracks.some((t) => t.key === 'billionaire_mindset'));
  assert.deepEqual(prefillFor(tone, founder, true), { tone: 'high_pressure', _pf_tone: true });
  assert.equal(synthesis.coaching.tone, 'high_pressure');
  assert.equal(synthesis.coaching.label, 'High-Pressure Coaching');
  assert.equal(prefillFor(tone, { games: ['wealth'] }, false), undefined, 'not suggested → no preselect');
  assert.equal(synthesizeProfile({ games: ['wealth'], load: 9 }, { startDate: START }).coaching.tone, 'gentle', 'load 8+ recommends gentle');
  assert.equal(synthesizeProfile({ ...founder, tone: 'gentle' }, { startDate: START }).coaching.tone, 'gentle', 'her pick wins');
  assert.equal(synthesizeProfile({ games: ['operator'], equity: false }, { startDate: START }).tracks.some((t) => t.key === 'billionaire_mindset'), false, 'operator without equity: no BHPC Track');
  assert.equal(synthesizeProfile({ games: ['operator'], equity: true }, { startDate: START }).tracks.some((t) => t.key === 'billionaire_mindset'), true);
});

test('Today coaching-mode chips: High-Pressure, Executive Review, Recovery always; Sprint and Deep Work when they apply', () => {
  assert.deepEqual(coachingModeChips({ games: ['wealth'] }).map((c) => c.mode), ['high_pressure', 'executive_review', 'recovery']);
  assert.deepEqual(coachingModeChips({ games: ['founder'], deadlines: ['launch'] }).map((c) => c.mode), ['high_pressure', 'executive_review', 'recovery', 'sprint', 'deep_work']);
});

test('the in-bed routine: Yes/Sometimes → 8 moves, 10 minutes, morning step 1; gentle range on a safety yes or prefer-not-to-say', () => {
  assert.equal(BED_ROUTINE.length, 8);
  assert.equal(BED_ROUTINE_GENTLE.length, 8);
  assert.equal(BED_ROUTINE.reduce((s, m) => s + m.minutes, 0), 10);
  assert.equal(BED_ROUTINE_GENTLE.reduce((s, m) => s + m.minutes, 0), 10);
  assert.equal(generateBedRoutine('no', 'no'), undefined);
  for (const answer of ['yes', 'sometimes']) {
    const routine = generateBedRoutine(answer, 'no');
    assert.equal(routine.gentle, false);
    assert.match(routine.note, /Stop anything that hurts/);
  }
  for (const safety of ['yes', 'skip']) {
    const gentle = generateBedRoutine('yes', safety);
    assert.equal(gentle.gentle, true);
    assert.ok(!gentle.moves.some((m) => /dead bug|glute bridges/i.test(m.move)), 'loaded moves swapped out');
  }
  const s = synthesizeProfile({ _health: 'yes', games: ['weight'], bed: 'sometimes', clinician_flag: 'skip', launch: 'calm' }, { startDate: START });
  assert.equal(s.morning[0], BED_ROUTINE_STEP);
  assert.ok(s.morning.length <= 5);
  assert.equal(s.bedRoutine.gentle, true);
  assert.equal(synthesizeProfile({ _health: 'yes', games: ['weight'], bed: 'no' }, { startDate: START }).morning[0] === BED_ROUTINE_STEP, false);
  const payload = toInstallPayload({ _health: 'yes', games: ['weight'], goal: 'lose_weight', bed: 'yes', clinician_flag: 'yes' }, { startDate: START, draftVersion: 3 });
  assert.equal(payload.morningSequence[0], BED_ROUTINE_STEP);
  assert.deepEqual(payload.intakeProfile.bedRoutine, { gentle: true });
  assert.equal(payload.intakeProfile.bodySafety, 'yes');
});

test('Mind, Body and Spirit are on by default; unticking one switches its areas off (the foreground area stays)', () => {
  const core = questionById('core_pillars');
  assert.deepEqual(prefillFor(core, {}, false), { core_pillars: ['mind', 'body', 'spirit'], _pf_core_pillars: true });
  const all = synthesizeProfile({ games: ['founder'] }, { startDate: START }).pillars;
  assert.deepEqual(all.pillars.map((p) => [p.pillar, p.enabled]), [['mind', true], ['body', true], ['spirit', true]]);
  assert.ok(all.pillars.every((p) => p.areas.length > 0), 'each pillar has at least one area');
  const noSpirit = synthesizeProfile({ games: ['founder'], core_pillars: ['mind', 'body'] }, { startDate: START }).pillars;
  assert.equal(noSpirit.pillars.find((p) => p.pillar === 'spirit').enabled, false);
  assert.ok(!noSpirit.activeAreas.some((area) => ['faith', 'meditation', 'gratitude', 'nature', 'service', 'family'].includes(area)));
  // A founder who unticks Mind keeps the work area: her #1 goal lives there.
  const noMind = synthesizeProfile({ games: ['founder'], core_pillars: ['body', 'spirit'] }, { startDate: START }).pillars;
  assert.equal(noMind.keptForForeground, 'mind');
  assert.deepEqual(noMind.pillars.find((p) => p.pillar === 'mind').areas.map((a) => a.area), ['work']);
  // Weight loss cannot switch Body off: the game is the body.
  assert.equal(synthesizeProfile({ games: ['weight'], core_pillars: ['mind'] }, { startDate: START }).pillars.pillars.find((p) => p.pillar === 'body').enabled, true);
  const payload = toInstallPayload({ games: ['founder'], core_pillars: ['mind', 'body'] }, { startDate: START, draftVersion: 1 });
  assert.deepEqual(payload.pillarsEnabled, ['mind', 'body']);
});

test('areas: critical from the foreground and the lines; floors from her chips mapped to areas', () => {
  const s = synthesizeProfile({ games: ['parent', 'founder'], foreground: 'founder', goal: 'customers', lines: ['dinner', 'sleep'], floors: ['Send one decisive follow-up', 'One protected family touchpoint (20 min, phone away)'] }, { startDate: START });
  assert.equal(s.pillars.foregroundArea, 'work');
  assert.ok(s.pillars.criticalAreas.includes('work') && s.pillars.criticalAreas.includes('family') && s.pillars.criticalAreas.includes('sleep'));
  assert.equal(s.pillars.minimumFloors.work, 'Send one decisive follow-up');
  assert.equal(s.pillars.minimumFloors.family, 'One protected family touchpoint (20 min, phone away)');
  const mind = s.pillars.pillars.find((p) => p.pillar === 'mind');
  assert.equal(mind.areas.find((a) => a.area === 'work').label, 'Business', 'work is labelled per persona');
  for (const [game, chips] of Object.entries(FLOOR_CHIPS)) for (const chip of chips) assert.ok(chip.area, `${game}: ${chip.label} has an area`);
  const off = synthesizeProfile({ games: ['founder'], crit_work: false }, { startDate: START });
  assert.equal(off.pillars.criticalAreas.includes('work'), false, 'critical toggle on the summary wins');
});

test('area-level review rolls up to the three pillars: "Mind ✓ Body ✓ Spirit –"', () => {
  const review = [{ pillar: 'work', score: 'hit' }, { pillar: 'money', score: 'miss' }, { pillar: 'movement', score: 'hit' }];
  const up = rollUpPillars(review, ['work', 'movement']);
  assert.deepEqual(up, { mind: 'hit', body: 'hit', spirit: 'none' });
  assert.equal(formatPillarRollUp(up), 'Mind ✓ Body ✓ Spirit –');
  assert.equal(rollUpPillars(review, ['work', 'money']).mind, 'partial', 'one critical area missed');
  assert.equal(rollUpPillars([{ pillar: 'faith', score: 'partial' }], ['faith'], { recovery: true }).spirit, 'hit', 'partial counts on a recovery day');
  assert.equal(rollUpPillars(review, ['work'], { enabled: ['mind', 'body'] }).spirit, 'none', 'switched-off pillar');
});

test('suggested pillars are classified into an area, deterministically, and move with one tap', () => {
  const cases = [['My marriage', 'family', 'spirit'], ['Church on Sundays', 'faith', 'spirit'], ['Learn guitar', 'learning', 'mind'], ['Pay down my car loan', 'money', 'mind'], ['Sleep better', 'sleep', 'body'], ['Volunteer at the shelter', 'service', 'spirit'], ['Therapy', 'mental_health', 'mind'], ['Morning runs', 'movement', 'body'], ['Get off my phone', 'focus', 'mind'], ['Something odd', 'learning', 'mind']];
  for (const [text, area, pillar] of cases) {
    const c = classifySuggestedArea(text);
    assert.equal(c.area, area, text);
    assert.equal(c.pillar, pillar, text);
  }
  assert.equal(classifySuggestedArea('Something odd').by, 'default');
  assert.deepEqual(moveSuggestedArea({ label: 'Guitar' }, 'meditation'), { label: 'Guitar', area: 'meditation', pillar: 'spirit', by: 'keyword' });
  assert.equal(moveSuggestedArea({ label: 'Guitar' }, 'execution'), undefined, 'legacy or unknown keys are refused');
});

test('Mind library: journaling supplies the prompt (never a blank page), reading follows the modality, focus follows the lines', () => {
  assert.deepEqual(Object.keys(MIND_PRACTICES), ['journaling', 'reading', 'learning_plan', 'focus_hygiene', 'therapy', 'weekly_reflection']);
  assert.ok(JOURNAL_PROMPTS.length >= 28);
  const base = { spirit: [], cadence: 'daily' };
  const [j1] = generatePractices({ ...base, mind: ['journaling'] }, '2026-10-05');
  const [j2] = generatePractices({ ...base, mind: ['journaling'] }, '2026-10-06');
  assert.match(j1.title, /^Journal for 5 minutes: .+\?$/);
  assert.notEqual(j1.title, j2.title, 'a new prompt each day');
  assert.equal(j1.floor.title, 'Write one line in your journal');
  assert.ok(j1.floor.durationMinutes <= 5);
  assert.match(generatePractices({ ...base, mind: ['reading'], learningTopic: 'leadership', learningModality: 'audio' }, START)[0].title, /^Listen to one chapter/);
  assert.match(generatePractices({ ...base, mind: ['reading'], learningModality: 'read' }, START)[0].title, /^Read 10 pages, or one chapter/);
  const plan = generatePractices({ ...base, mind: ['learning_plan'], learningTopic: 'money' }, '2026-10-20', '2026-10-05')[0];
  assert.match(plan.title, /^Learning plan, week 3 of 4: /);
  assert.equal(plan.steps.length, 4);
  assert.match(generatePractices({ ...base, mind: ['focus_hygiene'], lines: ['no_screens_8'] }, START)[0].title, /8 PM/);
  const therapy = generatePractices({ ...base, mind: ['therapy'] }, START)[0];
  assert.equal(therapy.cadence, 'weekly');
  assert.doesNotMatch(therapy.title, /diagnos|treat/i, 'tracked, never treatment');
  assert.equal(generatePractices({ ...base, mind: ['weekly_reflection'] }, START)[0].steps.length, 3);
  // Defaults: Mind with nothing chosen still gets journaling (one line, prompt supplied).
  const s = synthesizeProfile({ games: ['wealth'] }, { startDate: START });
  assert.ok(s.practices.some((p) => p.key === 'journaling'));
});

test('Spirit library: pre-ticked from practices; faith wording only with consent; a guided script with counts', () => {
  assert.deepEqual(Object.keys(SPIRIT_PRACTICES), ['faith', 'meditation', 'gratitude', 'nature', 'service', 'family_time']);
  const spirit = questionById('spirit');
  assert.deepEqual(prefillFor(spirit, { practices: ['prayer', 'gratitude'] }, false), { spirit: ['faith', 'gratitude'], _pf_spirit: true });
  assert.deepEqual(prefillFor(spirit, { fixed: ['worship'] }, false).spirit, ['faith']);
  const faith = generatePractices({ mind: [], spirit: ['faith'], faithLanguage: false }, START);
  assert.equal(faith.length, 1, 'chosen Faith = consent');
  assert.equal(faith[0].floor.title, '1 minute of prayer or silence');
  const secular = generatePractices({ mind: [], spirit: ['meditation', 'gratitude', 'nature', 'service'] }, START);
  for (const p of secular) assert.doesNotMatch(`${p.title} ${p.steps.join(' ')}`, /\b(pray|prayer|god|scripture|worship)\b/i, `${p.key} is secular`);
  const med = secular.find((p) => p.key === 'meditation');
  assert.ok(med.steps.some((step) => /\d/.test(step)), 'counts written out');
  assert.ok(MEDITATION_SCRIPTS.every((m) => m.steps.length >= 4));
  assert.match(secular.find((p) => p.key === 'gratitude').title, /^Write 3 lines of gratitude: .+; .+; .+$/);
  for (const p of [...faith, ...secular]) {
    assert.ok(p.floor.durationMinutes <= 5, `${p.key} floor is tiny`);
    assert.ok(['daily', 'few', 'weekly'].includes(p.cadence));
  }
  // Without Faith chosen, the morning "faith" launch is the only faith wording, and only if she picked it.
  const none = synthesizeProfile({ games: ['founder'], spirit: ['none'] }, { startDate: START });
  assert.ok(!none.practices.some((p) => p.key === 'faith'));
  assert.ok(none.practices.some((p) => p.pillar === 'spirit'), 'Spirit still gets the secular default');
});

test('practices reach Today through the plan: daily Mind/Spirit floors with a rotating title, validated like every floor', () => {
  const payload = synthesizeProfile({ games: ['founder'], goal: 'customers', practices: ['journaling'], spirit: ['gratitude'] }, { startDate: START });
  const plan = payload.plan;
  assert.deepEqual(validatePlan(plan), []);
  assert.ok(plan.floors.includes('practice:journaling') && plan.floors.includes('practice:gratitude'));
  const day1 = supplyDailyActions(plan, { date: START, state: 'normal' });
  const day2 = supplyDailyActions(plan, { date: '2026-10-06', state: 'normal' });
  const j1 = day1.floors.find((f) => f.actionKey === 'practice:journaling');
  const j2 = day2.floors.find((f) => f.actionKey === 'practice:journaling');
  assert.notEqual(j1.title, j2.title, 'prompt rotates by plan day');
  assert.equal(j1.pillar, 'mental_health');
  const recovery = supplyDailyActions(plan, { date: '2026-10-06', state: 'recovery' });
  const jr = recovery.floors.find((f) => f.actionKey === 'practice:journaling');
  assert.equal(jr.title, 'Write one line in your journal', 'MVD floor on a recovery day');
});

test('install payload: one call, idempotency key from the draft version, areas and the structured profile; no catch-all text', () => {
  const run = walk({ ...PERSONAS.founder, catchall: 'My mother is moving in next month' });
  const payload = toInstallPayload(run.draft.answers, { startDate: START, timezone: 'America/Chicago', draftVersion: run.draft.version });
  assert.equal(payload.idempotencyKey, `intake-v${run.draft.version}`);
  assert.ok(payload.trackKeys.includes('operator_discipline'));
  assert.ok(payload.criticalPillars.every((a) => payload.activeAreas.includes(a)));
  assert.ok(payload.morningSequence.length >= 1 && payload.morningSequence.length <= 5);
  assert.ok(!JSON.stringify(payload).includes('mother is moving'), 'the catch-all never rides the install payload');
  assert.equal(payload.intakeProfile.bankVersion, 2);
  assert.ok(payload.primaryGoal.length >= 5);
});

test('every persona installs end to end, full and quick, back and forth included (AT13 at the state layer)', () => {
  for (const [name, persona] of Object.entries(PERSONAS)) {
    for (const mode of ['full', 'quick']) {
      const run = walk(persona, mode);
      const payload = toInstallPayload(run.draft.answers, { startDate: START, draftVersion: run.draft.version });
      assert.deepEqual(validatePlan(synthesizeProfile(run.draft.answers, { startDate: START }).plan), [], `${name}/${mode} plan valid`);
      assert.ok(payload.roles.length >= 1, `${name}/${mode}`);
    }
  }
});


test('the questionnaire is questions only: no screen that asks nothing sits between questions (owner ruling 7 Oct 2026)', () => {
  for (const mode of [undefined, 'quick', 'full']) {
    for (const a of [{}, { games: ['founder', 'parent', 'athlete'], bed: 'yes', mode }]) {
      const p = path(a, mode);
      assert.equal(p.filter((s) => s.kind === 'interstitial').length, 0, `no interstitials in the ${mode ?? 'default'} path`);
      const firstReveal = p.findIndex((s) => s.id === 'building');
      assert.ok(firstReveal > 0, 'the reveal still follows the questions');
      assert.ok(p.slice(0, firstReveal).every((s) => ['question', 'account', 'express'].includes(s.kind)), 'only questions (and the account/choice steps) before the reveal');
    }
  }
});

// Owner's choice (7 Oct 2026, the restyle brief): the express "Quick start or full setup" step
// stays in the intake path, for the default (no mode yet) and the full mode alike.
test('the express "Quick start or full setup" step stays on the intake path in default and full modes', () => {
  const express = SECTIONS.find((section) => section.kind === 'express');
  assert.ok(express, 'the bank has the express section');
  assert.equal(express.name, 'Quick start or full setup');
  for (const [label, answers, mode] of [['default (no mode chosen)', {}, undefined], ['full (chosen)', { mode: 'full' }, 'full'], ['full (from the answer)', { mode: 'full' }, undefined]]) {
    const ids = path(answers, mode).map((screen) => screen.id);
    assert.ok(ids.includes('express'), `${label}: express is on the path`);
    assert.equal(path(answers, mode).find((screen) => screen.id === 'express').kind, 'express');
    assert.ok(ids.indexOf('express') > 0 && ids.indexOf('express') < ids.indexOf('summary'), `${label}: after the first questions, before the reveal`);
  }
});

// ---------------------------------------------------------------- consumer health data (owner, 8 Oct 2026)
test('without the health-data consent no health question is asked, and the weight game and health goals are not offered', () => {
  const body = SECTIONS.find((section) => section.id === 's5').questions.map((q) => q.id).filter((id) => id !== 'core_pillars');
  assert.deepEqual([...HEALTH_DATA_QUESTION_IDS].sort(), [...body, 'bed', 'bed_move', 'load'].sort(), 'the list is the Body section, the in-bed routine and the mental-load score');
  for (const [name, persona] of Object.entries(PERSONAS)) {
    for (const decision of [undefined, 'no']) {
      const script = { ...persona, _health: decision, games: persona.games.filter((g) => g !== 'weight').concat(persona.games.includes('weight') ? ['athlete'] : []) };
      if (decision === undefined) delete script._health;
      for (const mode of ['full', 'quick']) {
        const run = walk(script, mode);
        const asked = run.questions.filter((id) => HEALTH_DATA_QUESTION_IDS.includes(id));
        assert.deepEqual(asked, [], `${name} ${mode} ${decision ?? 'never asked'}: ${asked.join(', ')}`);
        const payload = toInstallPayload(run.draft.answers, { startDate: START, draftVersion: run.draft.version });
        assert.equal(payload.intakeProfile.loadBaseline, undefined, 'the mental-load score is not asked or installed');
        assert.equal(payload.intakeProfile.bodySafety, undefined);
        assert.equal(payload.intakeProfile.bedRoutine, undefined);
      }
    }
  }
  const games = questionById('games');
  assert.ok(!options(games, {}).some(([v]) => v === 'weight'), 'no weight game without consent');
  assert.ok(options(games, { _health: 'yes' }).some(([v]) => v === 'weight'), 'offered with consent');
  const goal = questionById('goal');
  assert.ok(!options(goal, { games: ['athlete'] }).some(([v]) => HEALTH_DATA_GOAL_IDS.includes(v)), 'no injury-return goal without consent');
  assert.ok(options(goal, { games: ['athlete'], _health: 'yes' }).some(([v]) => v === 'return_injury'));
  // With consent the same founder is asked the Body questions and the bed question.
  const consented = walk(PERSONAS.founder).questions;
  for (const id of ['move', 'workout_days', 'food', 'bed', 'load']) assert.ok(consented.includes(id), `${id} asked with consent`);
});

test('withoutHealthAnswers removes every health item and keeps everything else', () => {
  const answers = { _health: 'no', games: ['weight', 'founder'], foreground: 'weight', goal: 'eat_better', goal_size: 3, move: ['walk'], weight_now: 200, bed: 'yes', clinician_flag: 'yes', season: 'building', load: 7, carry: ['money'] };
  assert.deepEqual(withoutHealthAnswers(answers), { _health: 'no', games: ['founder'], season: 'building', carry: ['money'] });
  assert.deepEqual(withoutHealthAnswers({ games: ['founder'], goal: 'customers', goal_size: 10 }), { games: ['founder'], goal: 'customers', goal_size: 10 });
});
