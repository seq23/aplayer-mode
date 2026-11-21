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
  'integrations/deviceCalendar': 'export const chosenCalendars = () => []; export const listPhoneCalendars = () => []; export const syncChosenDeviceCalendars = () => {}; export const chooseCalendars = () => {}; export const removePhoneCalendarEvents = () => {};',
  'api/apmApi': `export const reportContent = async () => {};
    export const fetchFlexibleCalendarEvents = async () => ({ eventIds: [] });
    export const setAutopilotEventFlexible = async () => {};
    ${['approveExternalAction','rejectExternalAction','checkInToday','closeToday','completeAgendaAction','decideGoalPlan','replanToday','recordClinicianClearance','reprintToday','returnAndReset','reviewPlanGate','setTodayPhase','clearDeviceCalendarEvents','disconnectConnection','reactivateConnection','setConnectionLabel','setPrimaryConnection','syncCloudCalendar','syncEmailConnection','syncDeviceCalendarEvents'].map((name) => `export const ${name} = () => {};`).join('\n')}`,
  'today/FirstRunCards': ['BedRoutineToday', 'CoachingModeChips', 'PillarRollUpLine', 'PracticesToday', 'QuickTaps', 'SaveAccountBanner'].map((name) => `export const ${name} = () => null;`).join('\n'),
  ui: `import { createElement as h } from 'react';
    const component = (tag) => ({ children, title, message, subtitle, label, value, details }) => h(tag, {}, title, subtitle, message, label, value, details, children);
    export const Button = ({ label, disabled, busy }) => h('button', { disabled, 'aria-busy': busy }, label);
    export const LinkButton = ({ children, accessibilityLabel }) => h('button', { 'aria-label': accessibilityLabel }, children);
    export const uiStyles = {};
    ${['AnswerCard','Body','Card','CardTitle','ChoiceRow','Disclosure','Divider','EmptyState','ErrorState','Fill','Flow','Heading','Icon','KeyValue','Label','ListRow','Muted','Pill','Row','Screen','SectionTitle','Small','Stack','TextField','Toast'].map((name) => `export const ${name} = component('${name === 'Screen' ? 'main' : 'div'}');`).join('\n')}`,
};
const bundle = await build({
  stdin: { contents: `
    export { default as Today } from './app/(tabs)/today';
    export { default as RadarWhy } from './app/radar/why';
    export { default as Connections } from './app/settings/privacy/connections';
    export { ActionApprovalCard } from './src/components/today/ActionApprovalCard';
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
const { Today, RadarWhy, Connections, ActionApprovalCard, buildDailyPlan } = module.exports;
const at = (hour) => { const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(hour, 0, 0, 0); return day.toISOString(); };
const reply = { id: 'reply', status: 'prepared', requiresApproval: true, idempotencyKey: 'suite:reply:1', payload: {
  suiteProposal: 'reply', subject: 'Rehearsal schedule', to: 'jordan@example.com', account: 'Music inbox',
  body: 'Thanks for your message about rehearsal.', expiresAt: at(17),
} };
const move = { id: 'calendar', status: 'prepared', requiresApproval: true, idempotencyKey: 'suite:calendar_fix:1', payload: {
  suiteProposal: 'calendar_fix', title: 'Equipment inventory', account: 'Work calendar', timezone: 'UTC',
  originalStartsAt: at(10), originalEndsAt: at(11), startsAt: at(13), endsAt: at(14),
} };
const events = [{ id: 'first', title: move.payload.title, startsAt: at(10), endsAt: at(11), connectionId: 'calendar', organizer: { self: true }, attendees: [], recurrence: {} }];
const conflict = { id: 'radar:calendar_conflict:first:second', status: 'open', headline: 'Equipment inventory overlaps focus time',
  type: 'conflict', severity: 'high', summary: 'Two blocks overlap', confidence: 1, reasonCodes: ['calendar.busy_overlap'], sourceRefs: [] };

function fixture(overrides) {
  const graph = {
    identity: { userId: 'player', timezone: 'UTC' }, personalOS: { activeMode: 'standard', morningSequence: [] },
    entitlement: { plan: 'life_os', status: 'active' }, calendarEvents: [], connections: [], nextActions: [], radarItems: [conflict], evidence: [],
    dayRecords: [], tracks: [], routines: [], commitments: [], goals: [], actions: [reply, move], ...overrides,
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

test('Today removes rejected, executed, expired and downgraded proposals; busy cards disable further decisions', () => {
  fixture({ actions: [{ ...reply, status: 'cancelled' }, { ...move, status: 'verified' }] });
  assert.doesNotMatch(render(Today), /Report this (draft reply|calendar proposal)/);
  fixture({ actions: [{ ...move, payload: { ...move.payload, originalStartsAt: '2000-01-01T08:00:00Z' } }] });
  assert.doesNotMatch(render(Today), /Report this calendar proposal/);
  fixture({ entitlement: { plan: 'chief_of_staff', status: 'active' } });
  assert.doesNotMatch(render(Today), /Report this (draft reply|calendar proposal)/);
  const card = render(ActionApprovalCard, { action: reply, busyId: reply.id });
  assert.equal((card.match(/disabled=""/g) ?? []).length, 2);
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
