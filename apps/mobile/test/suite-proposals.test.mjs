import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const dir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const mockModules = {
  'expo-router': 'export const router = {}; export const useLocalSearchParams = () => ({ id: globalThis.suiteTest.radarId });',
  'react-native': "export const View = ({ children }) => children; export const Platform = { OS: 'web' };",
  'state/lifeGraph': 'export const useLifeGraph = () => globalThis.suiteTest.life;',
  'state/session': 'export const useSession = () => ({ accessToken: globalThis.suiteTest.token });',
  'state/consent': 'export const useConsent = () => ({});',
  'billing/purchases': "export const appDistribution = () => 'web'; export const billingAvailability = () => ({ available: false });",
  'integrations/oauth': 'export const connectOAuthProvider = () => {};',
  'intake/storage': 'export const readSync = () => null; export const writeSync = () => {}; export const removeSync = () => {};',
  'integrations/deviceCalendar': 'export const chosenCalendars = () => []; export const listPhoneCalendars = () => []; export const syncChosenDeviceCalendars = () => {}; export const chooseCalendars = () => {}; export const removePhoneCalendarEvents = () => {};',
  'api/apmApi': `export const reportContent = async () => {}; export const setPermission = async () => {};
    export const fetchFlexibleCalendarEvents = async () => ({ eventIds: [] });
    export const setAutopilotEventFlexible = async () => {};
    ${['approveExternalAction','rejectExternalAction','undoExternalAction','checkInToday','closeToday','completeAgendaAction','decideGoalPlan','replanToday','recordClinicianClearance','reprintToday','returnAndReset','reviewPlanGate','setTodayPhase','clearDeviceCalendarEvents','disconnectConnection','reactivateConnection','setConnectionLabel','setPrimaryConnection','syncCloudCalendar','syncEmailConnection','syncDeviceCalendarEvents'].map((name) => `export const ${name} = () => {};`).join('\n')}`,
  'today/FirstRunCards': ['BedRoutineToday', 'CoachingModeChips', 'PillarRollUpLine', 'PracticesToday', 'QuickTaps', 'SaveAccountBanner'].map((name) => `export const ${name} = () => null;`).join('\n'),
  ui: `import { createElement as h } from 'react';
    const component = (tag) => ({ children, title, message, subtitle, label, value, details }) => h(tag, {}, title, subtitle, message, label, value, details, children);
    export const Button = ({ label, disabled, busy }) => h('button', { disabled, 'aria-busy': busy }, label);
    export const LinkButton = ({ children, accessibilityLabel }) => h('button', { 'aria-label': accessibilityLabel }, children);
    export const TextField = ({ label, value, editable }) => h('textarea', { 'aria-label': label, defaultValue: value, disabled: editable === false });
    export const uiStyles = {};
    ${['AnswerCard','Body','Card','CardTitle','ChoiceRow','Disclosure','Divider','EmptyState','ErrorState','Fill','Flow','Heading','Icon','KeyValue','Label','ListRow','Muted','Pill','Row','Screen','SectionTitle','Small','Stack','Toast'].map((name) => `export const ${name} = component('${name === 'Screen' ? 'main' : 'div'}');`).join('\n')}`,
};
const bundle = await build({
  stdin: { contents: `
    export { default as Today } from './app/(tabs)/today';
    export { default as Radar } from './app/(tabs)/radar';
    export { default as RadarWhy } from './app/radar/why';
    export { default as Connections } from './app/settings/privacy/connections';
    export { default as LifeAreas } from './app/settings/life';
    export { default as Autonomy } from './app/settings/privacy/autonomy';
    export { ActionApprovalCard } from './src/components/today/ActionApprovalCard';
    export { previewRequest } from './src/preview/server';
    export { buildDailyPlan } from '@apm/planning';`, resolveDir: dir },
  platform: 'node', format: 'cjs', jsx: 'automatic', bundle: true, write: false,
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'native-and-network-boundaries',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, ({ path }) => {
        const key = path === './ui' || path === '../ui' || path.endsWith('/components/ui') ? 'ui'
          : Object.keys(mockModules).find((entry) => path === entry || path.endsWith('/' + entry));
        if (key) return { path: key, namespace: 'suite-test' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'suite-test' }, ({ path }) => ({ contents: mockModules[path] }));
    },
  }],
});
const module = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, require);
const { Today, Radar, RadarWhy, Connections, LifeAreas, Autonomy, ActionApprovalCard, buildDailyPlan, previewRequest } = module.exports;
const at = (hour) => { const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(hour, 0, 0, 0); return day.toISOString(); };
const reply = { id: 'reply', status: 'prepared', approvalAvailable: true, requiresApproval: true, idempotencyKey: 'suite:reply:1', payload: {
  suiteProposal: 'reply', aiGenerated: true, subject: 'Rehearsal schedule', to: 'jordan@example.com', account: 'Music inbox',
  body: 'Thanks for your message about rehearsal.', expiresAt: at(17),
} };
const move = { id: 'calendar', status: 'prepared', approvalAvailable: true, requiresApproval: true, idempotencyKey: 'suite:calendar_fix:1', payload: {
  suiteProposal: 'calendar_fix', title: 'Equipment inventory', clash: 'Overlaps Research block', account: 'Work calendar', timezone: 'UTC',
  originalStartsAt: at(10), originalEndsAt: at(11), startsAt: at(13), endsAt: at(14),
} };
const events = [{ id: 'first', title: move.payload.title, startsAt: at(10), endsAt: at(11), connectionId: 'calendar', availability: 'busy', organizer: { self: true }, attendees: [], recurrence: {} }];
const conflict = { id: 'radar:calendar_conflict:first:second', status: 'open', headline: 'Equipment inventory overlaps focus time',
  type: 'conflict', severity: 'high', summary: 'Two blocks overlap', confidence: 1, reasonCodes: ['calendar.busy_overlap'], sourceRefs: [] };

function fixture(overrides) {
  const graph = {
    identity: { userId: 'player', timezone: 'UTC' }, personalOS: { activeMode: 'standard', morningSequence: [] },
    entitlement: { plan: 'life_os', status: 'active' }, calendarEvents: [], connections: [], nextActions: [], radarItems: [conflict], evidence: [],
    dayRecords: [], people: [], lifeAdminItems: [], lifeRelationships: [], permissions: [], tracks: [], routines: [], commitments: [], goals: [], actions: [reply, move], ...overrides,
  };
  const todayPlan = buildDailyPlan(graph);
  globalThis.suiteTest = {
    token: 'test-token', radarId: conflict.id,
    life: { graph, todayPlan, isDurable: true, syncStatus: 'ready', todayLoop: {
      checkedIn: false, closed: true, agenda: { mode: 'standard', firstHour: { sequence: [] }, dailyStack: [], background: [], problems: [], safety: {} }, dayState: { state: 'standard' }, weeklyReview: {}, coachingCheckIn: {}, drift: { drifting: false }, closePreview: { pillarReview: [] },
    } },
  };
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test('Today renders both prepared proposals, their reviewable details, report and decision controls', () => {
  fixture();
  const page = render(Today);
  for (const detail of [reply.payload.subject, reply.payload.to, reply.payload.account, reply.payload.body, move.payload.title, move.payload.account]) {
    assert.ok(page.includes(detail), detail);
  }
  assert.match(page, /Report this draft reply/);
  assert.match(page, /Report this calendar proposal/);
  assert.match(page, /Current time/);
  assert.match(page, /Proposed time/);
  assert.equal((page.match(/>Approve<\/button>/g) ?? []).length, 2);
  assert.equal((page.match(/>Reject<\/button>/g) ?? []).length, 2);
});

test('Today shows recent decision receipts, hides expired and downgraded proposals, and disables busy cards', () => {
  const updatedAt = new Date().toISOString();
  fixture({ actions: [{ ...reply, status: 'cancelled', updatedAt }, { ...move, status: 'verified', updatedAt }] });
  const outcomes = render(Today);
  assert.match(outcomes, />Skipped</);
  assert.match(outcomes, />Moved</);
  assert.match(outcomes, />Undo<\/button>/);
  assert.doesNotMatch(outcomes, /Report this (draft reply|calendar proposal)/);
  fixture({ actions: [{ ...reply, status: 'verified', updatedAt }] });
  assert.match(render(Today), />Sent</);
  assert.match(render(Today), /jordan@example.com in the original thread/);
  fixture({ actions: [{ ...move, payload: { ...move.payload, originalStartsAt: '2000-01-01T08:00:00Z' } }] });
  assert.doesNotMatch(render(Today), /Report this calendar proposal/);
  fixture({ entitlement: { plan: 'chief_of_staff', status: 'active' } });
  assert.doesNotMatch(render(Today), /Report this (draft reply|calendar proposal)/);
  const card = render(ActionApprovalCard, { action: reply, busyId: reply.id });
  assert.equal((card.match(/disabled=""/g) ?? []).length, 3);
  assert.match(card, /aria-busy="true"/);
});

test('Radar detail renders a flexibility control for the solo block and hides it on Roundtable', () => {
  fixture({ calendarEvents: events });
  assert.match(render(RadarWhy), /Checking your calendar preferences/);
  fixture({ calendarEvents: events, entitlement: { plan: 'chief_of_staff', status: 'active' } });
  assert.doesNotMatch(render(RadarWhy), /Which block can move/);
});

test('Connections shows separate account write consent', () => {
  fixture({ connections: [{ id: 'account', kind: 'email', provider: 'microsoft', label: 'Music inbox', scopes: ['Mail.Read'], status: 'connected', isPrimary: true }] });
  assert.match(render(Connections), /read only/);
  fixture({ connections: [{ id: 'account', kind: 'email', provider: 'microsoft', label: 'Music inbox', scopes: ['Mail.Send'], status: 'connected', isPrimary: true }] });
  assert.match(render(Connections), /write consent given/);
});

test('Connections offers Outlook Mail and Google Calendar with no Gmail consent button', () => {
  fixture({ connections: [], entitlement: { plan: 'autopilot', status: 'active' } });
  const page = render(Connections);
  assert.match(page, /<button[^>]*>Connect Outlook \/ Microsoft Mail<\/button>/);
  assert.match(page, /<button[^>]*>Connect Google Calendar<\/button>/);
  assert.doesNotMatch(page, /<button[^>]*>Connect Gmail<\/button>/);
  assert.doesNotMatch(page, /<button[^>]*>Allow writes on this account<\/button>/);
});

test('Today points a Google Calendar Suite user without Outlook Mail to the connection that brings drafts', () => {
  fixture({ actions: [], connections: [{ id: 'cal', kind: 'calendar', provider: 'google', status: 'connected', scopes: [] }] });
  const page = render(Today);
  assert.match(page, /Outlook Mail/);
  assert.match(page, /<button[^>]*>Manage connections<\/button>/);
  assert.doesNotMatch(page, />Approve<\/button>/);
});

const checklist = { id: 'goal-checklist', status: 'prepared', approvalAvailable: true, requiresApproval: true, idempotencyKey: 'suite:goal_checklist:1', payload: {
  suiteProposal: 'goal_checklist', title: 'Get ready to record the first interview', detail: 'A location and a microphone picked out', expiresAt: at(17),
} };
const block = { ...move, id: 'goal-calendar', idempotencyKey: 'suite:goal_calendar:1', payload: {
  ...move.payload, suiteProposal: 'goal_calendar', title: 'Edit the opening scene', detail: 'First cut of the opening scene', expiresAt: at(17),
} };
const missed = { ...move, id: 'missed-day', idempotencyKey: 'suite:admin_defer:1', payload: {
  ...move.payload, suiteProposal: 'missed_day', title: 'Pick up printer paper', expiresAt: at(17),
} };
const hard = { ...missed, id: 'hard-day', idempotencyKey: 'suite:admin_defer:2', payload: {
  ...missed.payload, suiteProposal: 'hard_day', title: 'Plan next week’s lunches',
} };

test('Today renders both methods for arranging a goal step and the checklist after approval', () => {
  fixture({ actions: [block, checklist] });
  const page = render(Today);
  for (const detail of [checklist.payload.title, checklist.payload.detail, block.payload.title, block.payload.detail, block.payload.account]) assert.ok(page.includes(detail));
  assert.match(page, /Approve to add this block/);
  assert.match(page, /Approve to add this to your goal checklist/);
  assert.equal((page.match(/Report this proposal/g) ?? []).length, 2);

  fixture({ actions: [{ ...checklist, status: 'verified' }], nextActions: [{ id: checklist.id, status: 'open', title: checklist.payload.title }] });
  const approved = render(Today);
  assert.ok(approved.includes(checklist.payload.title));
  assert.match(approved, /Saved for your next full day/);
  assert.ok(!approved.includes('>Approve</button>'));
});

test('minimum-day and hard-day proposals render during recovery with the old slot, destination, and decision controls', () => {
  fixture({ actions: [missed, hard, block, { ...checklist, status: 'cancelled' }] });
  globalThis.suiteTest.life.todayLoop.agenda.mode = 'recovery';
  const page = render(Today);
  for (const expected of [missed.payload.title, hard.payload.title, 'Current slot', 'New slot', 'Life areas', 'deadlines and calendar']) {
    assert.ok(page.includes(expected), expected);
  }
  assert.ok(!page.includes(block.payload.title));
  assert.equal((page.match(/Report this proposal/g) ?? []).length, 2);
  assert.equal(page.split('>Approve</button>').length - 1, 2);
  assert.equal(page.split('>Reject</button>').length - 1, 2);

  fixture({ actions: [{ ...hard, payload: { ...hard.payload, day: '2000-01-01' } }], entitlement: { plan: 'chief_of_staff', status: 'active' } });
  assert.ok(!render(Today).includes('>Approve</button>'));
});

test('Life areas and Permissions expose the task and approval setup for Suite', () => {
  fixture({ lifeAdminItems: [{ id: 'errand', kind: 'shopping', title: 'Pick up printer paper', status: 'open', importance: 2, recurrence: {}, details: { flexibleSchedule: true }, startsAt: at(12) }] });
  assert.match(render(LifeAreas), /Pick up printer paper/);
  const permissions = render(Autonomy);
  assert.match(permissions, /Goal checklists and task moves/);
  assert.match(permissions, /Approve &amp; execute/);
  fixture({ entitlement: { plan: 'chief_of_staff', status: 'active' } });
  assert.match(render(LifeAreas), /Life areas need/);
});

test('Today renders an editable AI draft, the named clash and a prepare-only state without Approve', () => {
  fixture({ actions: [{ ...reply, approvalAvailable: false }, { ...move, approvalAvailable: false }] });
  const page = render(Today);
  assert.match(page, /<textarea[^>]*aria-label="Reply draft"/);
  assert.match(page, />AI draft</);
  assert.match(page, /Research block/);
  assert.match(page, />Prepare only</);
  assert.match(page, />Action permissions<\/button>/);
  assert.doesNotMatch(page, />Approve<\/button>/);
});

test('Today and Connections render a reconnect action for a failed Outlook mailbox', () => {
  fixture({ actions: [], connections: [{ id: 'failed', kind: 'email', provider: 'microsoft', scopes: ['Mail.Read', 'Mail.Send'],
    label: 'Music inbox', status: 'needs_reauth', isPrimary: true }] });
  const today = render(Today);
  assert.match(today, /Music inbox needs reconnecting/);
  assert.match(today, />Reconnect<\/button>/);
  const settings = render(Connections);
  assert.match(settings, /Needs reconnecting/);
  assert.match(settings, />Reconnect Outlook \/ Microsoft Mail<\/button>/);
  assert.doesNotMatch(settings, />Sync now<\/button>/);
});

test('a provider outage shows a calm retry line, never a reconnect button', () => {
  fixture({ actions: [], connections: [{ id: 'blip', kind: 'email', provider: 'microsoft', scopes: ['Mail.Read', 'Mail.Send'],
    label: 'Music inbox', status: 'error', isPrimary: true }] });
  const today = render(Today);
  assert.match(today, /Outlook isn(?:'|&#x27;)t responding/);
  assert.doesNotMatch(today, />Reconnect<\/button>/);
  assert.match(render(Connections), /Not responding, retrying/);
});

test('Radar and Today show the flagged subscription and the proposed cancellation email with AI reporting', () => {
  const cancel = { ...reply, id: 'cancel', idempotencyKey: 'suite:subscription_cancel:1', reason: 'Subscription price may have gone up',
    payload: { ...reply.payload, suiteProposal: 'subscription_cancel', title: 'Community pool passes', to: 'support@example.com' } };
  const signal = { ...conflict, id: 'radar:subscription:pool', type: 'recurring', headline: 'Community pool passes may cost more now',
    summary: 'Review the cancellation email on Today.', reasonCodes: ['subscription.price_rise'], confidence: 0.75 };
  fixture({ actions: [cancel], radarItems: [signal] });
  globalThis.suiteTest.radarId = signal.id;
  const today = render(Today);
  assert.match(today, /Community pool passes/);
  assert.match(today, /support@example.com/);
  assert.match(today, /Report this proposal/);
  assert.match(today, />Approve<\/button>/);
  const radar = render(Radar);
  assert.match(radar, /Community pool passes may cost more now/);
  assert.match(radar, /AI finding/);
  assert.match(radar, /Report this item/);
  assert.match(render(RadarWhy), /AI identified a subscription notice/);
});

test('the CI web preview reaches every paid Suite state: each sample card can be approved, the draft is model-shaped', async () => {
  await previewRequest('/v1/preview/sample-account', { method: 'POST', body: '{}' });
  const { graph } = await previewRequest('/v1/me/today');
  const suite = graph.actions.filter((action) => action.idempotencyKey.startsWith('suite:') && action.status === 'prepared');
  const kinds = new Set(suite.map((action) => action.payload.suiteProposal));
  for (const kind of ['reply', 'calendar_fix', 'goal_checklist', 'goal_calendar', 'missed_day', 'hard_day', 'subscription_cancel', 'clear_day']) assert.ok(kinds.has(kind), kind);
  for (const action of suite) {
    const card = renderToStaticMarkup(createElement(ActionApprovalCard, { action, onApprove() {}, onReject() {} }));
    assert.match(card, />Approve<\/button>/, `${action.payload.suiteProposal} can be approved in the preview`);
  }
  const reply = suite.find((action) => action.payload.suiteProposal === 'reply');
  assert.equal(reply.payload.aiGenerated, true);
  assert.doesNotMatch(reply.payload.body, /received your request/i, 'never the fixed receipt line');
  assert.ok(reply.payload.body.includes('?'), 'a grounded draft answers the thread');
});

test('Today shows the clear-day card with who is told, and an Autopilot move with Undo or a plain "Not moved"', () => {
  const clear = { id: 'clear', domain: 'calendar', actionType: 'calendar.reschedule', status: 'prepared', requiresApproval: true, approvalAvailable: true,
    idempotencyKey: 'suite:clear_day:1', reason: 'Clear today to your minimum day', payload: { suiteProposal: 'clear_day', title: 'Choir planning call',
      account: 'Home calendar', timezone: 'UTC', others: 2, notify: true, originalStartsAt: at(10), originalEndsAt: at(11), startsAt: at(14), endsAt: at(15) } };
  const card = renderToStaticMarkup(createElement(ActionApprovalCard, { action: clear, onApprove() {}, onReject() {}, onReport: async () => {} }));
  assert.match(card, /Clear today to your minimum day/);
  assert.match(card, /2 other people invited/);
  assert.match(card, />Approve<\/button>/);
  assert.match(card, />Reject<\/button>/);
  const composed = { title: 'Pick up dry cleaning', originalStartsAt: at(20), originalEndsAt: at(21), startsAt: at(14), endsAt: at(15) };
  const moved = { id: 'auto', domain: 'calendar', actionType: 'calendar.reschedule', status: 'verified', requiresApproval: false,
    idempotencyKey: 'autopilot:suite:clear_day:1', reason: 'Clear today to your minimum day', payload: { composed } };
  const done = renderToStaticMarkup(createElement(ActionApprovalCard, { action: moved, onApprove() {}, onReject() {}, onUndo() {}, timezoneHint: 'UTC' }));
  assert.match(done, /Moved by Autopilot/);
  assert.match(done, /Pick up dry cleaning/);
  assert.match(done, />Undo<\/button>/);
  const failed = renderToStaticMarkup(createElement(ActionApprovalCard, { action: { ...moved, status: 'failed' }, onApprove() {}, onReject() {}, onUndo() {}, timezoneHint: 'UTC' }));
  assert.match(failed, /Not moved/);
  assert.doesNotMatch(failed, /Moved by Autopilot|>Undo</);
});

test('the preview Today shows the pending clear-day card ("Choir planning call") among its approvals', async () => {
  await previewRequest('/v1/preview/sample-account', { method: 'POST', body: '{}' });
  const state = await previewRequest('/v1/me/today');
  const shown = new Set(state.plan.approvalActionIds);
  const clear = state.graph.actions.find((action) => action.payload.suiteProposal === 'clear_day' && action.status === 'prepared');
  assert.equal(clear.payload.title, 'Choir planning call');
  assert.ok(shown.has(clear.id), 'the clear-day card is on Today');
});

test('no approval card renders "undefined", "null" or an empty line: every preview card and a goal card without its detail', async () => {
  await previewRequest('/v1/preview/sample-account', { method: 'POST', body: '{}' });
  const { graph } = await previewRequest('/v1/me/today');
  const cards = graph.actions.filter((action) => action.idempotencyKey.startsWith('suite:') || action.idempotencyKey.startsWith('autopilot:'));
  assert.ok(cards.length >= 8, `found ${cards.length} sample cards`);
  const goal = cards.find((action) => action.payload.suiteProposal === 'goal_calendar');
  assert.ok(typeof goal.payload.detail === 'string' && goal.payload.detail.length > 0, 'the sample goal card carries its detail');
  const bare = { ...goal, id: 'bare', payload: { ...goal.payload, detail: undefined } };
  for (const action of [...cards, bare]) {
    const html = renderToStaticMarkup(createElement(ActionApprovalCard, { action, onApprove() {}, onReject() {}, onUndo() {}, timezoneHint: 'UTC' }));
    const text = html.replace(/<[^>]+>/g, '\n');
    assert.doesNotMatch(text, /\bundefined\b|\bnull\b|NaN|Invalid Date/, `${action.idempotencyKey}: ${text.replace(/\n+/g, ' | ')}`);
    assert.doesNotMatch(html, /<(p|div|span)[^>]*><\/\1>/, `${action.idempotencyKey}: no empty text line`);
  }
});
