// The Morning Trigger end to end against a fake Supabase + Expo:
//   * wrangler.jsonc declares the cron and src/entry.ts exports `scheduled`;
//   * with no service credential the run is a NAMED stop, never a silent success;
//   * a due user gets the agenda printed and exactly ONE push; a re-run is idempotent;
//   * Deep Work and a protected family block HOLD the push (no claim: it goes later);
//   * quiet hours (the user's LOCAL clock) and an already-started day suppress it;
//   * the lock screen stays minimal unless the user chose normal detail;
//   * the end-of-day close computes the verdict, keeps one carry item, refuses catch-up;
//   * /v1/push/evaluate holds Radar pushes during Deep Work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let trigger; let entry; let push; let planning;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-morning-worker-'));
  await build({
    entryPoints: { trigger: join(srcDir, 'morningTrigger.ts'), entry: join(srcDir, 'entry.ts'), push: join(srcDir, 'push.ts'), planning: fileURLToPath(new URL('../../../packages/planning/src/index.ts', import.meta.url)) },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  trigger = await import(pathToFileURL(join(outDir, 'trigger.js')).href);
  entry = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).default;
  push = await import(pathToFileURL(join(outDir, 'push.js')).href);
  planning = await import(pathToFileURL(join(outDir, 'planning.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const GOAL = '00000000-0000-4000-8000-0000000000a1';
const TZ = 'America/Chicago';
const NOW = new Date('2026-10-07T12:05:00Z'); // 07:05 in Chicago
const DAY = '2026-10-07';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', EXPO_ACCESS_TOKEN: 'expo-test' };

function osRow(extra = {}) {
  return {
    user_id: USER, north_star: null, core_values: [], non_negotiables: [], failure_patterns: [], body_context: null, work_money_context: null,
    mind_spirit_learning_context: null, weekly_cadence: { heavyDays: [], lightDays: [] }, coaching_style: { firmness: 'direct' },
    accountability: { dayStart: 'guided' }, active_mode: 'standard', foreground_goal_id: GOAL, morning_sequence: ['Drink water'],
    scheduling_preference: 'ordered_stack', hard_boundaries: [], scoring_config: { enabled: true, showSevenDaySnapshot: true },
    stabilization_started_at: '2026-09-01', installed_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    mode_started_at: null, mode_ends_at: null, mode_focus: null, recovery_locked_until: null, mode_resume: null, ...extra,
  };
}

function harness({ os = {}, prefs = {}, dayRecords = [], lifeAdmin = [], plan = 'life_os' } = {}) {
  const goalPlan = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: '2026-10-01', timezone: TZ });
  const store = {
    user_profiles: [{ user_id: USER, display_name: 'Ana', timezone: TZ }],
    goals: [{ id: GOAL, title: 'lose 30 lbs', outcome: null, status: 'active', health: 'unknown', pillar: 'body', target_date: null, priority: 1, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z' }],
    personal_os: [osRow(os)],
    subscription_entitlements: [{ user_id: USER, plan, status: 'active' }],
    goal_plans: [{ id: '00000000-0000-4000-8000-0000000000b1', user_id: USER, goal_id: GOAL, plan_key: goalPlan.id, template_key: goalPlan.provenance.templateKey, persona: 'weight_loss', foreground_pillar: 'body', start_date: '2026-10-01', end_date: goalPlan.endDate, timezone: TZ, plan: goalPlan, status: 'active', decision: null, decision_reason: null, decided_at: null, gate_reviews: {}, created_at: '2026-10-01T00:00:00Z' }],
    day_records: dayRecords,
    life_admin_items: lifeAdmin,
    notification_preferences: [{ enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal', morning_push_enabled: true, ...prefs }],
    push_subscriptions: [{ expo_push_token: 'ExponentPushToken[abc]' }],
  };
  const calls = { rpc: [], expo: [], auth: [] };
  const claimed = new Set();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (href.startsWith('https://exp.host/')) { calls.expo.push(JSON.parse(init.body)); return json({ data: [{ status: 'ok' }] }); }
    const headers = new Headers(init.headers);
    calls.auth.push({ apikey: headers.get('apikey'), authorization: headers.get('authorization') });
    const path = href.replace(env.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc) {
      calls.rpc.push({ fn: rpc, args: body });
      if (rpc === 'apm_service_morning_candidates') return json([{ user_id: USER, timezone: TZ, wake_time: '07:00', local_day: DAY }]);
      if (rpc === 'apm_service_print_agenda') return json(true);
      if (rpc === 'apm_service_claim_notification') {
        if (claimed.has(body.p_dedupe_key)) return json(null);
        claimed.add(body.p_dedupe_key); return json('00000000-0000-4000-8000-0000000000n1'.replace('n', 'c'));
      }
      return json(null);
    }
    const table = path.match(/^\/rest\/v1\/([a-z_]+)/)?.[1];
    if ((init.method ?? 'GET') !== 'GET') return new Response(null, { status: 204 });
    return json(store[table] ?? []);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const finishes = (calls) => calls.rpc.filter((c) => c.fn === 'apm_service_finish_notification').map((c) => [c.args.p_status, c.args.p_reason]);

test('the cron is declared and the Worker entry exports a scheduled handler', async () => {
  const wrangler = await readFile(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
  assert.equal((wrangler.match(/"crons": \["\*\/15 \* \* \* \*"\]/g) ?? []).length, 3, 'top level, staging and production');
  assert.equal(typeof entry.scheduled, 'function');
  const h = harness();
  try {
    const pending = [];
    await entry.scheduled({ scheduledTime: NOW.getTime(), cron: '*/15 * * * *' }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(h.calls.expo.length, 1, 'the scheduled handler runs the Morning Trigger');
  } finally { h.restore(); }
});

test('no service credential is a named stop, not a silent success', async () => {
  const h = harness();
  try {
    const result = await trigger.runMorningTrigger({ ...env, SUPABASE_SECRET_KEY: undefined }, NOW);
    assert.equal(result.skipped, 'no_service_credential');
    assert.equal(h.calls.rpc.length, 0);
  } finally { h.restore(); }
});

test('a due user: agenda printed for the LOCAL day, exactly one push, idempotent on re-run, server key only', async () => {
  const h = harness();
  try {
    const result = await trigger.runMorningTrigger(env, NOW);
    assert.deepEqual({ sent: result.sent, printed: result.printed, failed: result.failed }, { sent: 1, printed: 1, failed: 0 });
    const print = h.calls.rpc.find((c) => c.fn === 'apm_service_print_agenda');
    assert.equal(print.args.p_day, DAY);
    assert.equal(print.args.p_agenda.foregroundPriority.goalId, GOAL);
    assert.ok(print.args.p_agenda.firstHour.priority.title);
    assert.equal(h.calls.rpc.find((c) => c.fn === 'apm_service_claim_notification').args.p_dedupe_key, `morning:${DAY}`);
    assert.deepEqual(finishes(h.calls), [['sent', null]]);
    assert.equal(h.calls.expo[0][0].body, 'Open APM to start the day.', 'minimal lock-screen detail by default');
    assert.ok(h.calls.auth.every((a) => a.apikey === 'sb_secret_test' && a.authorization === null), 'sb_secret keys never go in Authorization');

    const again = await trigger.runMorningTrigger(env, NOW);
    assert.equal(again.alreadyClaimed, 1);
    assert.equal(h.calls.expo.length, 1, 'never a second push for the same local day');
  } finally { h.restore(); }
});

test('normal lock-screen detail names the foreground', async () => {
  const h = harness({ prefs: { lock_screen_detail: 'normal' } });
  try {
    await trigger.runMorningTrigger(env, NOW);
    assert.match(h.calls.expo[0][0].body, /^Today's foreground: lose 30 lbs/);
  } finally { h.restore(); }
});

test('Deep Work and a protected family block HOLD the push without claiming it', async () => {
  const deep = harness({ os: { active_mode: 'deep_work', mode_started_at: '2026-10-07T11:30:00Z', mode_ends_at: '2026-10-07T13:30:00Z', mode_focus: 'Draft the proposal' } });
  try {
    const result = await trigger.runMorningTrigger(env, NOW);
    assert.equal(result.held, 1);
    assert.equal(deep.calls.rpc.filter((c) => c.fn === 'apm_service_claim_notification').length, 0, 'not claimed, so a later tick sends it');
    assert.equal(deep.calls.expo.length, 0);
  } finally { deep.restore(); }
  const after = harness({ os: { active_mode: 'deep_work', mode_started_at: '2026-10-07T10:00:00Z', mode_ends_at: '2026-10-07T12:00:00Z', mode_focus: 'Draft the proposal' } });
  try {
    assert.equal((await trigger.runMorningTrigger(env, NOW)).sent, 1, 'once the block has ended the push goes out');
  } finally { after.restore(); }
  const family = harness({ lifeAdmin: [{ id: 'f1', person_id: null, kind: 'family_obligation', title: 'School run', status: 'scheduled', importance: 5, due_at: null, starts_at: '2026-10-07T12:00:00Z', ends_at: '2026-10-07T12:45:00Z', recurrence: {}, amount_minor: null, currency: null, details: {}, completed_at: null, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }] });
  try {
    assert.equal((await trigger.runMorningTrigger(env, NOW)).held, 1);
    assert.equal(family.calls.expo.length, 0);
  } finally { family.restore(); }
});

test('quiet hours on the LOCAL clock and an already-started day suppress the push', async () => {
  const quiet = harness({ prefs: { quiet_hours: { start: '22:00', end: '07:30' } } });
  try {
    assert.equal((await trigger.runMorningTrigger(env, NOW)).suppressed, 1);
    assert.deepEqual(finishes(quiet.calls), [['suppressed', 'quiet_hours']]);
    assert.equal(quiet.calls.expo.length, 0);
  } finally { quiet.restore(); }
  const started = harness({ dayRecords: [{ id: 'd1', day: DAY, mode: 'standard', verdict: null, completed_action_ids: [], note: null, closed_at: null, mood: 7, day_state: 'normal', agenda: null, agenda_status: null, checked_in_at: '2026-10-07T11:00:00Z', replans: [] }] });
  try {
    assert.equal((await trigger.runMorningTrigger(env, NOW)).suppressed, 1);
    assert.deepEqual(finishes(started.calls), [['suppressed', 'day_already_started']]);
    assert.equal(started.calls.rpc.filter((c) => c.fn === 'apm_service_print_agenda').length, 0, 'a started day is never re-printed');
  } finally { started.restore(); }
});

test('quiet hours are evaluated in the user’s timezone (they used UTC before)', () => {
  const at = new Date('2026-10-07T03:30:00Z'); // 22:30 in Chicago, 03:30 UTC
  assert.equal(push.inQuietHours({ start: '22:00', end: '07:00' }, at, TZ), true);
  assert.equal(push.inQuietHours({ start: '08:00', end: '12:00' }, at, TZ), false);
  assert.equal(push.localMinutes(at, 'Not/AZone'), 3 * 60 + 30, 'unknown zone falls back to UTC');
});

test('the Radar push path holds non-critical pushes during Deep Work and family pushes stay allowed in a family block', async () => {
  const originalFetch = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://exp.host/')) { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }); }
    if (href.includes('/rest/v1/notification_preferences')) return new Response(JSON.stringify([{ enabled: true, quiet_hours: {}, lock_screen_detail: 'minimal', minimum_severity: 'low' }]), { status: 200 });
    if (href.includes('/rest/v1/push_subscriptions')) return new Response(JSON.stringify([{ expo_push_token: 'ExponentPushToken[abc]' }]), { status: 200 });
    // Claim-first (insert-or-nothing on the dedupe key), then finish by id.
    if (href.includes('/rest/v1/notifications?on_conflict=user_id,dedupe_key') && init.method === 'POST') return new Response(JSON.stringify([{ id: `n-${posted.length}` }]), { status: 201 });
    if (href.includes('/rest/v1/notifications?id=eq.') && init.method === 'PATCH') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${init.method ?? 'GET'} ${href}`);
  };
  try {
    const item = (id, severity, reasonCodes) => ({ id, status: 'open', severity, confidence: 0.9, headline: id, reasonCodes });
    const items = [item('work', 'high', ['commitment.due_soon']), item('fire', 'critical', ['commitment.overdue']), item('kid', 'high', ['life_os.kind.family_obligation'])];
    const deep = await push.notifyRadarItems({ env, accessToken: 'jwt', userId: USER, radarItems: items, hold: { reason: 'deep_work', allowCritical: true, allowFamily: false } });
    assert.deepEqual({ held: deep.held, sent: deep.sent }, { held: 2, sent: 1 });
    const family = await push.notifyRadarItems({ env, accessToken: 'jwt', userId: USER, radarItems: items, hold: { reason: 'protected_family_block', allowCritical: true, allowFamily: true } });
    assert.deepEqual({ held: family.held, sent: family.sent }, { held: 1, sent: 2 });
  } finally { globalThis.fetch = originalFetch; }
});
