// THE PREVIEW'S SAMPLE SERVER (free web preview only; .github/workflows/app-preview.yml).
//
// With EXPO_PUBLIC_APM_PREVIEW=1 every API call in src/api/apmApi.ts lands here instead of the
// network: no account, no purchase, nothing read from or written to api.aplayermode.com or the
// database. State lives in this browser only. A build without the flag never contains this file
// (metro.config.js resolves it to server.off.ts).
//
// It is a stand-in, not a second server: the rules are the real ones (packages/planning for the
// agenda, the day state and the 30/60/90 plan; services/api/src/coach for the Modes and the
// scripted coach), composed the way services/api/src/index.ts buildUserState composes them.
import {
  AREA_PILLAR, TRACK_DISPLAY_NAMES,
  type AreaKey, type AutonomyLevel, type AutopilotActionClassState, type AutopilotRule, type DayRecord, type Goal, type LifeGraphSnapshot,
  type Provenance, type StoredGoalPlan, type SubscriptionEntitlement,
} from '@apm/domain';
import {
  BUILTIN_MODES, CONSUMER_HEALTH_POLICY_VERSION, buildDailyPlan, calendarDateInTimezone, coachingCheckIn, composeAgenda, continuityView,
  dayInsight, dayStateFromGraph, detectDrift, firstWeekProgramme, generateGoalPlan, isPlanEligible, midDayReplanDecision, planContextFromGraph,
  scoreAgendaDay, suggestPillarReview, weeklyDebrief, weeklyReviewDue, withCompletionStatus,
  type DailyAgenda, type GoalPlan, type IntakeInstallPayload, type PlanEntry,
} from '@apm/planning';
import {
  PLAN_PRICES, REVENUECAT_CONFIG, autonomyLabels, capabilitiesForPlan, forbiddenStandingActions, formatUsdCents, maxAutonomyForPlan,
  productPlanPolicies, standingActionClasses, type PaidPlan, type ProductPlan,
} from '@apm/policy';
import { applyModeToPlan, modeView, transitionMode, type ModeRequest, type ModeState } from '../../../../services/api/src/coach/modes';
import { decideTurn, type CoachSessionState } from '../../../../services/api/src/coach/machine';
import type { ApiIntakeDraft, ConsentState, NotificationPreferences, TodayState } from '../api/apmApi';
import { ApiError } from '../api/errors';
import { readSync, removeSync, writeSync } from '../intake/storage';

const KEY = 'apm.preview.state.v1';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OFF = { error: 'preview', message: 'This is switched off in the preview. It works in the phone app.' };

interface State {
  consents: ConsentState;
  draft: ApiIntakeDraft | null;
  graph: LifeGraphSnapshot;
  mode: ModeState;
  coach?: { id: string; session: CoachSessionState; messages: string[] };
  prefs: NotificationPreferences;
  household: boolean;
  autopilotPaused: boolean;
  rules: AutopilotRule[];
  seq: number;
}

const stamp = () => new Date().toISOString();
const stated = (): Provenance => ({ kind: 'stated', sourceType: 'manual', createdAt: stamp() });

function emptyGraph(): LifeGraphSnapshot {
  return {
    identity: { userId: USER, displayName: '' },
    roles: [], pillarSettings: [], tracks: [], modes: [], personalOS: undefined, goals: [], milestones: [], projects: [], commitments: [],
    nextActions: [], routines: [], people: [], lifeRelationships: [], lifeAdminItems: [], preferences: [], rules: [], radarItems: [],
    evidence: [], connections: [], calendarEvents: [], messageSignals: [], permissions: [], actions: [], dayRecords: [], goalPlans: [],
    planCompletions: [], diaryEntries: [], weeklyReviews: [], osChanges: [], entitlement: undefined,
  };
}

function fresh(): State {
  return {
    consents: { ageConfirmedAt: null, healthData: null },
    draft: null,
    graph: emptyGraph(),
    mode: { mode: 'standard' },
    prefs: { enabled: true, morning_push_enabled: true, wake_time: '06:30', lock_screen_detail: 'minimal', quiet_hours: { start: '21:30', end: '06:30' }, minimum_severity: 'medium' },
    household: false,
    autopilotPaused: false,
    rules: [],
    seq: 0,
  };
}

let s: State = (() => {
  try { const raw = readSync(KEY); if (raw) return { ...fresh(), ...(JSON.parse(raw) as State) }; } catch { /* a damaged copy starts again */ }
  return fresh();
})();
const save = () => writeSync(KEY, JSON.stringify(s));
/** A v4-shaped id (some screens and the real API validate the shape). */
const id = () => { s.seq += 1; return `00000000-0000-4000-8000-${String(s.seq).padStart(12, '0')}`; };

// ---------------------------------------------------------------- sample data
/** The account behind "I already have an account": two games, so no single persona is implied. */
const SAMPLE_INSTALL: IntakeInstallPayload = {
  displayName: 'Sam',
  roles: ['Parent', 'Professional'],
  primaryGoal: 'Run a 10K in 12 weeks',
  currentSeason: 'A full job, two school runs a day and a body that wants attention',
  pillar: 'movement',
  goalOutcome: 'Finish a 10K without walking',
  firstNextAction: 'Lay out running shoes and kit by the door tonight',
  northStar: 'Be strong, present and calm for the people who count on me',
  values: ['Family first', 'Keep my word', 'Steady over heroic'],
  nonNegotiables: ['School pickup at 3:15', 'Phone away at dinner'],
  failurePatterns: ['Overcommitting on Mondays', 'Skipping sleep to finish work'],
  weeklyCadence: { heavyDays: ['Tuesday', 'Thursday'], lightDays: ['Saturday'], reviewDay: 'Sunday', recoveryDay: 'Saturday' },
  coachingStyle: { firmness: 'direct' },
  accountability: { dayStart: 'guided', coachingReminderAfterDays: 3 },
  criticalPillars: ['movement', 'family'],
  activeAreas: ['work', 'movement', 'sleep', 'family', 'gratitude'],
  pillarsEnabled: ['mind', 'body', 'spirit'],
  minimumFloors: { movement: 'Walk for 10 minutes', family: 'Ten phone-free minutes with the kids', sleep: 'Lights out by 10:30 pm', work: 'One focused 25-minute block', gratitude: 'Write one line of thanks' },
  trackKeys: ['body_foundation', 'home_front'],
  activeMode: 'standard',
  morningSequence: ['Drink a glass of water', 'Two minutes of stretching', 'Read today’s first item out loud'],
  schedulingPreference: 'loose_dayparts',
  hardBoundaries: ['No meetings before 9:00', 'No work email after 8:00 pm'],
  scoringConfig: { enabled: true, showSevenDaySnapshot: true },
  foregroundProjectName: '10K training block',
  foregroundProjectObjective: 'Three runs a week, building to 10 km',
  reviewGateDays: 30,
  intakeProfile: {
    bankVersion: 1, games: ['parent', 'professional'], mentalLoadItems: [], fixedCommitments: [], lineIds: [], deadlines: [], realWork: [], fakeWork: [],
    wealthContext: [], careerLevers: [], mindPractices: [], spiritPractices: [], faithLanguage: false, coachingHelps: [], coachingAvoid: [],
    quickStart: false, deferredQuestionIds: [], suggestedAreas: [],
  },
  idempotencyKey: 'preview-sample-1',
};

const at = (hour: number, minute = 0) => { const d = new Date(); d.setHours(hour, minute, 0, 0); return d.toISOString(); };

/** A few clearly-labelled sample items so Radar, Connections and Life areas are not empty rooms. */
function sampleSurroundings(graph: LifeGraphSnapshot): LifeGraphSnapshot {
  const connection = { id: id(), userId: USER, provider: 'google' as const, kind: 'calendar' as const, accountLabel: 'sample@example.com', label: 'Sample calendar', isPrimary: true, status: 'connected' as const, scopes: ['calendar.readonly'], lastSyncAt: stamp() };
  const person = { id: id(), userId: USER, name: 'Jordan (sample)', relationship: 'Sister', provenance: stated() };
  const goalId = graph.goals[0]?.id;
  return {
    ...graph,
    connections: [connection],
    calendarEvents: [
      { id: id(), userId: USER, connectionId: connection.id, provider: 'google', externalEventId: 'sample-1', title: 'Team stand-up (sample)', startsAt: at(9, 30), endsAt: at(10), allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false },
      { id: id(), userId: USER, connectionId: connection.id, provider: 'google', externalEventId: 'sample-2', title: 'School pickup (sample)', startsAt: at(15, 15), endsAt: at(15, 45), allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false },
    ],
    people: [person],
    lifeRelationships: [{ id: id(), userId: USER, personId: person.id, birthday: '1990-03-14', cadenceDays: 14, notes: 'Sample contact', provenance: stated(), createdAt: stamp(), updatedAt: stamp() }],
    lifeAdminItems: [
      { id: id(), userId: USER, kind: 'appointment', title: 'Dentist check-up (sample)', status: 'scheduled', importance: 3, startsAt: at(16, 30), endsAt: at(17), recurrence: {}, details: {}, provenance: stated(), createdAt: stamp(), updatedAt: stamp() },
      { id: id(), userId: USER, kind: 'bill', title: 'Car insurance renewal (sample)', status: 'open', importance: 4, dueAt: at(23, 59), recurrence: { frequency: 'yearly' }, amountMinor: 64000, currency: 'USD', details: {}, provenance: stated(), createdAt: stamp(), updatedAt: stamp() },
    ],
    radarItems: [
      { id: id(), userId: USER, type: 'conflict', headline: 'Stand-up runs into your focus block (sample)', summary: 'The 9:30 stand-up overlaps the first block of your day.', status: 'open', severity: 'medium', confidence: 0.9, importance: 0.6, urgency: 0.7, goalAlignment: 0.5, consequence: 0.4, sourceRefs: [{ sourceType: 'calendar', label: 'Sample calendar' }], reasonCodes: ['calendar.overlap'], ...(goalId ? { relatedGoalId: goalId } : {}), createdAt: stamp(), firstRelevantAt: stamp() },
      { id: id(), userId: USER, type: 'upcoming', headline: 'Car insurance renews today (sample)', summary: 'A yearly bill is due. Nothing is paid for you; this is a reminder.', status: 'open', severity: 'high', confidence: 1, importance: 0.7, urgency: 0.9, goalAlignment: 0.2, consequence: 0.6, sourceRefs: [{ sourceType: 'manual', label: 'Life areas' }], reasonCodes: ['life_os.due_today'], createdAt: stamp(), firstRelevantAt: stamp() },
      { id: id(), userId: USER, type: 'slipping', headline: 'Two weeks since you called Jordan (sample)', summary: 'You asked to be in touch every 14 days.', status: 'open', severity: 'low', confidence: 0.8, importance: 0.4, urgency: 0.3, goalAlignment: 0.3, consequence: 0.2, sourceRefs: [{ sourceType: 'manual', label: 'Life areas' }], reasonCodes: ['relationship.cadence'], createdAt: stamp(), firstRelevantAt: stamp() },
    ],
    permissions: [{ id: id(), userId: USER, domain: 'calendar', actionType: 'calendar.create', autonomyLevel: 2, constraints: {}, enabled: true, grantedAt: stamp(), updatedAt: stamp() }],
  };
}

const SAMPLE_PLAN: SubscriptionEntitlement = { userId: USER, plan: 'autopilot', status: 'active', provider: 'app_store', billingPeriod: 'monthly', offer: 'standard', storeProductId: 'preview.sample' };

/** PUT /v1/methodology/intake: the answers become the Personal OS (the real server does this in SQL). */
function install(input: IntakeInstallPayload) {
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const goal: Goal = {
    id: id(), userId: USER, title: input.primaryGoal.trim() || SAMPLE_INSTALL.primaryGoal, status: 'active', health: 'on_track', priority: 1, provenance: stated(),
    ...(input.goalOutcome ? { outcome: input.goalOutcome } : {}), ...(input.pillar ? { pillar: input.pillar } : {}), ...(input.goalTargetDate ? { targetDate: input.goalTargetDate } : {}),
  };
  const project = { id: id(), userId: USER, goalId: goal.id, title: input.foregroundProjectName || goal.title, objective: input.foregroundProjectObjective, status: 'active' as const, foreground: true, reviewGateDays: 30 as const };
  const areas = input.activeAreas.length ? input.activeAreas : SAMPLE_INSTALL.activeAreas;
  const base: LifeGraphSnapshot = {
    ...emptyGraph(),
    entitlement: s.graph.entitlement,
    identity: { userId: USER, displayName: input.displayName || s.graph.identity.displayName, timezone, ...(input.currentSeason ? { currentSeason: input.currentSeason } : {}) },
    roles: input.roles.map((name) => ({ id: id(), userId: USER, name, active: true, provenance: stated() })),
    pillarSettings: areas.map((name: AreaKey) => ({ userId: USER, name, pillar: AREA_PILLAR[name], active: true, critical: input.criticalPillars.includes(name), ...(input.minimumFloors[name] ? { minimumFloor: input.minimumFloors[name] } : {}) })),
    tracks: input.trackKeys.map((key, index) => ({ id: id(), userId: USER, key, name: TRACK_DISPLAY_NAMES[key], active: true, foreground: index === 0, provenance: stated() })),
    modes: BUILTIN_MODES.map((mode) => ({ id: id(), userId: USER, key: mode.key, name: mode.name, active: mode.key === 'standard', provenance: stated() })),
    goals: [goal],
    projects: [project],
    nextActions: input.firstNextAction ? [{ id: id(), userId: USER, goalId: goal.id, projectId: project.id, title: input.firstNextAction, status: 'open', estimatedMinutes: 25 }] : [],
    personalOS: {
      userId: USER, values: input.values, nonNegotiables: input.nonNegotiables, failurePatterns: input.failurePatterns,
      weeklyCadence: input.weeklyCadence, coachingStyle: input.coachingStyle, accountability: input.accountability, activeMode: 'standard',
      foregroundGoalId: goal.id, morningSequence: input.morningSequence, schedulingPreference: input.schedulingPreference, hardBoundaries: input.hardBoundaries,
      scoringConfig: input.scoringConfig, stabilizationStartedAt: calendarDateInTimezone(new Date(), timezone), trackSettings: {}, pillarsEnabled: input.pillarsEnabled,
      intakeProfile: input.intakeProfile, installedAt: stamp(), updatedAt: stamp(),
      ...(input.northStar ? { northStar: input.northStar } : {}), ...(input.bodyContext ? { bodyContext: input.bodyContext } : {}),
      ...(input.workMoneyContext ? { workMoneyContext: input.workMoneyContext } : {}), ...(input.mindSpiritLearningContext ? { mindSpiritLearningContext: input.mindSpiritLearningContext } : {}),
    },
  };
  s.graph = sampleSurroundings(base);
  s.mode = { mode: 'standard' };
}

// ---------------------------------------------------------------- the composed Today
const today = () => calendarDateInTimezone(new Date(), s.graph.identity.timezone);
const planEntries = (graph: LifeGraphSnapshot): PlanEntry[] => (graph.goalPlans as unknown as Array<StoredGoalPlan<GoalPlan>>).map((record) => ({ record, plan: record.plan }));
const entitled = () => { const e = s.graph.entitlement; return Boolean(e && (e.status === 'active' || e.status === 'trialing')); };

/** Every active goal of an entitled, installed account has a 30/60/90 plan (services/api dailyLoop ensureGoalPlans). */
function ensurePlans() {
  if (!s.graph.personalOS || !entitled()) return;
  for (const goal of s.graph.goals.filter((g) => g.status === 'active' && !s.graph.goalPlans.some((plan) => plan.goalId === g.id))) {
    const outcome = goal.outcome?.trim();
    const text = outcome && outcome.toLowerCase() !== goal.title.trim().toLowerCase() ? `${goal.title.trim()}. ${outcome}` : goal.title.trim();
    try {
      const plan = generateGoalPlan(text, planContextFromGraph(s.graph, { startDate: today(), goal }));
      const stored: StoredGoalPlan<GoalPlan> = {
        id: id(), userId: USER, goalId: goal.id, planKey: plan.id, templateKey: plan.provenance.templateKey, persona: plan.persona.key, foregroundPillar: plan.foreground.pillar,
        startDate: plan.startDate, endDate: plan.endDate, plan, status: 'active', gateReviews: {}, createdAt: stamp(), ...(plan.timezone ? { timezone: plan.timezone } : {}),
      };
      s.graph = { ...s.graph, goalPlans: [...s.graph.goalPlans, stored as unknown as StoredGoalPlan] };
    } catch { /* one goal the engine cannot plan stays planless; Today still opens */ }
  }
}

function freshAgenda(graph: LifeGraphSnapshot, date: string, state: DailyAgenda['state'], mood?: number): DailyAgenda {
  const carried = graph.dayRecords.find((record) => record.day < date && record.closedAt && record.carryForward);
  const sameDay = (iso: string | undefined) => Boolean(iso && calendarDateInTimezone(iso, graph.identity.timezone) === date);
  return composeAgenda({
    tracks: {
      active: graph.tracks.filter((track) => track.active).map((track) => track.key),
      roles: graph.roles.filter((role) => role.active).map((role) => role.name),
      settings: graph.personalOS?.trackSettings ?? {},
      referral: Boolean(graph.personalOS?.bodyReferral),
      ...(graph.identity.timezone ? { timezone: graph.identity.timezone } : {}),
      calendar: graph.calendarEvents.filter((event) => !event.deleted && !event.allDay && event.availability !== 'free' && sameDay(event.startsAt)).map((event) => ({ title: event.title, startsAt: event.startsAt, endsAt: event.endsAt })),
      familyBlocks: [],
      recentVerdicts: graph.dayRecords.filter((record) => record.day < date && record.verdict).sort((a, b) => b.day.localeCompare(a.day)).map((record) => record.verdict!),
    },
    ...(carried?.carryForward ? { carryForward: { text: carried.carryForward, fromDay: carried.day } } : {}),
    date, state, ...(mood !== undefined ? { mood } : {}),
    plans: planEntries(graph), goals: graph.goals, foregroundGoalId: graph.personalOS?.foregroundGoalId, completions: graph.planCompletions,
    morningSequence: graph.personalOS?.morningSequence ?? [], nextActions: graph.nextActions,
  });
}

function userState(): TodayState {
  ensurePlans();
  const now = new Date();
  const graph: LifeGraphSnapshot = { ...s.graph, personalOS: s.graph.personalOS ? { ...s.graph.personalOS, activeMode: s.mode.mode } : undefined };
  const projected = applyModeToPlan(buildDailyPlan(graph, { ...(s.mode.mode === 'recovery' ? { mode: 'recovery' as const } : {}), now }), graph, s.mode);
  const date = today();
  const day = graph.dayRecords.find((record) => record.day === date);
  const derived = dayStateFromGraph(graph, date, s.mode.mode === 'recovery');
  const locked = day?.agendaStatus === 'locked' && day.agenda ? (day.agenda as unknown as DailyAgenda) : undefined;
  const made = freshAgenda(graph, date, locked?.state ?? derived.state, day?.mood);
  const agenda = locked ? { ...withCompletionStatus(locked, graph.planCompletions, graph.nextActions), gateReviews: made.gateReviews, decisions: made.decisions } : made;
  const critical = graph.pillarSettings.filter((pillar) => pillar.active && pillar.critical).map((pillar) => pillar.name);
  const firstWeek = firstWeekProgramme(graph.personalOS?.stabilizationStartedAt, date);
  const loop = {
    date, agenda,
    dayState: locked ? { state: locked.state, reason: derived.reason } : derived,
    locked: Boolean(locked), checkedIn: Boolean(day?.checkedInAt), closed: Boolean(day?.closedAt),
    dayStart: graph.personalOS?.accountability.dayStart ?? 'guided',
    ...(day ? { day } : {}),
    continuity: continuityView(graph.dayRecords, date),
    showContinuity: graph.personalOS?.scoringConfig.showSevenDaySnapshot ?? true,
    closePreview: {
      pillarReview: suggestPillarReview(agenda), computedVerdict: scoreAgendaDay(agenda, critical).verdict,
      evidence: [agenda.firstHour.priority, ...agenda.dailyStack].filter((item) => item?.status === 'done').map((item) => item!.title),
    },
    ...(day?.phase ? { phase: day.phase } : {}),
    redacted: false,
    drift: detectDrift({ date, dayRecords: graph.dayRecords, completions: graph.planCompletions, firstActiveDay: planEntries(graph).filter((entry) => isPlanEligible(entry.record)).map((entry) => entry.record.startDate).sort()[0] }),
    ...(firstWeek ? { firstWeek } : {}),
    coachingCheckIn: coachingCheckIn({ installedAt: graph.personalOS?.installedAt, today: date, afterDays: graph.personalOS?.accountability.coachingReminderAfterDays }),
    weeklyReview: weeklyReviewDue({ today: date, reviewDay: graph.personalOS?.weeklyCadence.reviewDay, reviews: graph.weeklyReviews }),
  };
  return { graph, plan: projected.plan, mode: { ...modeView(s.mode, now), todayEffect: projected.effect }, today: loop } as unknown as TodayState;
}

/** Today's day record, created on first touch. */
function dayRecord(): DayRecord {
  const date = today();
  let day = s.graph.dayRecords.find((record) => record.day === date);
  if (!day) {
    day = { id: id(), userId: USER, day: date, mode: s.mode.mode, completedActionIds: [], replans: [] };
    s.graph = { ...s.graph, dayRecords: [...s.graph.dayRecords, day] };
  }
  return day;
}
const patchDay = (change: Partial<DayRecord>) => { const day = dayRecord(); s.graph = { ...s.graph, dayRecords: s.graph.dayRecords.map((record) => (record.id === day.id ? { ...record, ...change } : record)) }; };

function planResponse() {
  const raw: SubscriptionEntitlement = s.graph.entitlement ?? { userId: USER, plan: 'beta', status: 'expired' };
  const usable = raw.status === 'active' || raw.status === 'trialing';
  const policy = productPlanPolicies[raw.plan];
  const level = usable ? maxAutonomyForPlan(raw.plan, 'calendar') : 0;
  return {
    entitlement: { ...raw, hasPlan: Boolean(s.graph.entitlement), displayName: s.graph.entitlement ? policy.displayName : 'No plan yet', promise: policy.promise, capabilities: usable ? capabilitiesForPlan(raw.plan) : [], maxAutonomyLevel: level, maxAutonomyLabel: autonomyLabels[level] },
    billing: raw.provider === 'app_store' ? { store: 'app_store', period: raw.billingPeriod ?? null, founding: false, periodEnd: null, renews: usable, cancelAtPeriodEnd: false, billingIssue: false, pendingPlan: null } : null,
    plans: (Object.keys(productPlanPolicies) as ProductPlan[]).map((plan) => {
      const item = productPlanPolicies[plan];
      const max = maxAutonomyForPlan(plan, 'calendar');
      const price = plan in PLAN_PRICES ? PLAN_PRICES[plan as PaidPlan] : undefined;
      return {
        ...(price ? { monthlyUsdCents: price.monthlyUsdCents, annualUsdCents: price.annualUsdCents, monthlyPriceLabel: `${formatUsdCents(price.monthlyUsdCents)}/month`, annualPriceLabel: `${formatUsdCents(price.annualUsdCents)}/year`, packages: REVENUECAT_CONFIG.packages[plan as PaidPlan] } : {}),
        plan, displayName: item.displayName, promise: item.promise, publicAvailability: 'available', capabilities: capabilitiesForPlan(plan),
        maxAutonomyLevel: max, maxAutonomyLabel: autonomyLabels[max], priceLabel: price ? `${formatUsdCents(price.monthlyUsdCents)}/month` : '', highlights: [],
      };
    }),
  };
}

function autopilot() {
  const classes: AutopilotActionClassState[] = Object.values(standingActionClasses).map((policy) => ({
    actionClass: policy.actionClass, domain: policy.domain, connectorKind: policy.connector, actionType: policy.actionType, reversible: policy.reversible,
    undoMethod: policy.undo, undoLabel: policy.undoLabel, activationStatus: 'active',
  }));
  return {
    autopilot: { entitled: s.graph.entitlement?.plan === 'autopilot', masterPaused: s.autopilotPaused, classes, rules: s.rules, executions: [] },
    permissions: Object.values(standingActionClasses).map((policy) => {
      const permission = s.graph.permissions.find((p) => p.domain === policy.domain && p.actionType === policy.actionType);
      return { actionClass: policy.actionClass, domain: policy.domain, autonomyLevel: permission?.enabled ? permission.autonomyLevel : 0 };
    }),
    supported: Object.values(standingActionClasses),
    neverStanding: forbiddenStandingActions,
  };
}

function debrief(state: TodayState) {
  const foreground = state.today?.agenda.foregroundPriority;
  return weeklyDebrief({
    today: today(), dayRecords: s.graph.dayRecords, completions: s.graph.planCompletions, diary: s.graph.diaryEntries,
    ...(foreground ? { foreground: { planId: foreground.planId, label: foreground.label } } : {}), trackFlags: state.today?.agenda.trackFlags ?? [],
  });
}

function changeMode(request: ModeRequest) {
  const foreground = s.graph.projects.find((project) => project.foreground && project.status === 'active');
  const result = transitionMode(s.mode, request, { now: new Date(), ...(s.graph.identity.timezone ? { timezone: s.graph.identity.timezone } : {}), ...(foreground ? { foregroundTitle: foreground.title } : {}) });
  if (!result.ok) throw new ApiError(409, { error: result.error, message: result.message });
  s.mode = result.state;
}

function coachTurn(body: { message?: string; choice?: never; sessionId?: string }) {
  if (!s.coach || (body.sessionId && body.sessionId !== s.coach.id)) s.coach = { id: id(), session: { phase: 'exploring', questionsAsked: 0, deeperRounds: 0 }, messages: [] };
  const state = userState();
  const turn = decideTurn(s.coach.session, { ...(body.message ? { message: body.message } : {}), ...(body.choice ? { choice: body.choice } : {}) }, {
    mode: s.mode.mode, modeState: s.mode, graph: state.graph, plan: state.plan, now: new Date(), priorUserMessages: s.coach.messages,
  });
  const sessionId = s.coach.id;
  if (body.message) s.coach.messages.push(body.message);
  s.coach.session = turn.session;
  let rebuilt: TodayState | undefined;
  if (turn.modeRequest) { try { changeMode(turn.modeRequest); rebuilt = userState(); } catch { /* the transition rules refused; the reply stands */ } }
  if (turn.closeSession) s.coach = undefined;
  return {
    sessionId, mode: state.mode?.mode ?? 'standard', phase: turn.session.phase, step: turn.step, engine: 'scripted', reply: turn.reply, turnId: id(), prompt: turn.prompt,
    ...(turn.nextMove ? { nextMove: turn.nextMove } : {}), ...(turn.morningSequence ? { morningSequence: turn.morningSequence } : {}), ...(turn.review ? { review: turn.review } : {}),
    ...(turn.safety ? { safety: turn.safety } : {}), ...(turn.boundaryNote ? { boundaryNote: turn.boundaryNote } : {}), trackChallenges: turn.trackChallenges,
    modeState: (rebuilt ?? state).mode, ...(rebuilt ? { today: rebuilt } : {}),
  };
}

const ACTIVITY = [
  ['personal_os.installed', 'user', 'Your Personal OS was installed'],
  ['calendar.synced', 'connector', 'Sample calendar read: 2 events'],
  ['radar.item_created', 'system', 'Radar noticed a calendar overlap'],
] as const;

// ---------------------------------------------------------------- the router
function route(method: string, path: string, body: Record<string, unknown>): unknown {
  const [pathname = path, query = ''] = path.split('?');
  const seg = pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "v1"
  const is = (verb: string, pattern: string) => {
    if (verb !== method) return false;
    const want = pattern.split('/');
    return want.length === seg.length && want.every((part, index) => part === '*' || part === seg[index]);
  };
  const consents = () => ({ consents: s.consents, healthPolicyVersion: CONSUMER_HEALTH_POLICY_VERSION });
  const graph = (change: Partial<LifeGraphSnapshot>) => { s.graph = { ...s.graph, ...change }; return userState(); };
  const os = (change: Partial<NonNullable<LifeGraphSnapshot['personalOS']>>) => (s.graph.personalOS ? graph({ personalOS: { ...s.graph.personalOS, ...change, updatedAt: stamp() } }) : userState());

  // Identity, consent, setup
  if (is('GET', 'me/today')) return userState();
  if (is('GET', 'me/life-graph')) return { graph: userState().graph };
  if (is('GET', 'consents')) return consents();
  if (is('POST', 'consents/age')) { s.consents = { ...s.consents, ageConfirmedAt: stamp() }; return consents(); }
  if (is('POST', 'consents/health-data')) { s.consents = { ...s.consents, healthData: { decision: body.decision as 'granted', recordedAt: stamp(), policyVersion: CONSUMER_HEALTH_POLICY_VERSION } }; return consents(); }
  if (is('PUT', 'profile/name')) { graph({ identity: { ...s.graph.identity, displayName: String(body.displayName ?? '') } }); return { displayName: s.graph.identity.displayName }; }
  if (is('GET', 'intake/draft')) return { draft: s.draft };
  if (is('PUT', 'intake/draft')) { s.draft = { ...(body as unknown as ApiIntakeDraft), updatedAt: Date.now() }; return { draft: s.draft }; }
  if (is('POST', 'intake/draft/merge')) return { outcome: 'kept', draft: s.draft };
  if (is('POST', 'intake/synthesis')) return { source: 'deterministic', proposal: { trackKeys: body.trackKeys ?? [], floors: body.floors ?? {}, extracted: { boundaries: [], deadlines: [], commitments: [], radarSeeds: [] }, suggestedAreas: [] } };
  if (is('PUT', 'methodology/intake')) { install(body as unknown as IntakeInstallPayload); return userState(); }
  if (is('PUT', 'intake/profile')) return os({ intakeProfile: body.intakeProfile as never });
  if (is('POST', 'preview/sample-account')) {
    // "I already have an account": a finished sample account, 18+ on file, on a plan.
    if (!s.graph.personalOS) { s.graph = { ...s.graph, entitlement: SAMPLE_PLAN }; install(SAMPLE_INSTALL); }
    s.consents = { ageConfirmedAt: s.consents.ageConfirmedAt ?? stamp(), healthData: s.consents.healthData ?? { decision: 'declined', recordedAt: stamp(), policyVersion: CONSUMER_HEALTH_POLICY_VERSION } };
    return {};
  }
  if (is('POST', 'preview/reset')) { removeSync(KEY); s = fresh(); return {}; }

  // Plan and billing: nothing is ever bought here
  if (is('GET', 'product/plan')) return planResponse();
  if (is('GET', 'billing/offering')) return { offering: 'founding', offeringId: REVENUECAT_CONFIG.foundingOffering, founding: true, reservedUntil: null, appUserId: USER, spotsLeft: null };
  if (is('POST', 'billing/reconcile')) { graph({ entitlement: SAMPLE_PLAN }); return { reconciled: true, outcomes: ['preview_sample_plan'] }; }
  if (is('GET', 'billing/web/portal')) return { url: null, reason: 'not_configured' };
  if (is('GET', 'product/household-interest')) return { interested: s.household };
  if (is('PUT', 'product/household-interest')) { s.household = Boolean(body.interested); return { interested: s.household, updatedAt: stamp() }; }

  // The daily loop
  if (is('POST', 'methodology/mode')) { changeMode({ action: 'enter', ...body } as ModeRequest); return userState(); }
  if (is('POST', 'today/check-in')) {
    const state = userState();
    if (state.today && !state.today.checkedIn) {
      const mood = typeof body.mood === 'number' ? body.mood : undefined;
      const agenda = freshAgenda(state.graph, state.today.date, state.today.dayState.state, mood);
      patchDay({ agenda: agenda as unknown as Record<string, unknown>, agendaStatus: 'locked', checkedInAt: stamp(), dayState: agenda.state, ...(mood !== undefined ? { mood } : {}) });
    }
    return userState();
  }
  if (is('POST', 'today/actions/complete')) {
    const agenda = userState().today?.agenda;
    const key = String(body.actionKey);
    const item = agenda ? [agenda.firstHour.priority, ...agenda.dailyStack].find((entry) => entry?.planId === body.planId && entry?.actionKey === key) : undefined;
    if (!s.graph.planCompletions.some((done) => done.planId === body.planId && done.actionKey === key && done.day === today())) {
      s.graph = { ...s.graph, planCompletions: [...s.graph.planCompletions, {
        id: id(), userId: USER, planId: String(body.planId), day: today(), actionKey: key, instanceId: `${today()}:${key}`, scope: item?.scope ?? 'standard',
        role: agenda?.firstHour.priority?.actionKey === key ? 'foreground' : 'floor', createdAt: stamp(), ...(typeof body.note === 'string' ? { note: body.note } : {}),
      }] };
    }
    return userState();
  }
  if (is('POST', 'next-actions/*/complete')) return graph({ nextActions: s.graph.nextActions.map((action) => (action.id === seg[1] ? { ...action, status: 'done' as const } : action)) });
  if (is('POST', 'today/phase')) { patchDay({ phase: body.phase as 'first_hour' }); return userState(); }
  if (is('POST', 'today/return')) { patchDay({ returnedAt: stamp() }); return userState(); }
  if (is('POST', 'today/reprint')) return { ...userState(), replaced: [], stillInvalid: [] };
  if (is('POST', 'today/replan')) {
    const decision = midDayReplanDecision(body.reason as 'mood');
    if (!decision.allowed) throw new ApiError(409, { error: decision.code, message: decision.message });
    const state = userState();
    if (state.today) patchDay({ agenda: freshAgenda(state.graph, state.today.date, state.today.dayState.state, state.today.day?.mood) as unknown as Record<string, unknown>, replans: [...dayRecord().replans, { reason: String(body.reason), at: stamp(), ...(typeof body.detail === 'string' ? { detail: body.detail } : {}) }] });
    return { ...userState(), message: decision.message };
  }
  if (is('POST', 'today/close') || is('POST', 'methodology/day/close')) {
    const state = userState();
    const computed = state.today ? scoreAgendaDay(state.today.agenda as DailyAgenda, s.graph.pillarSettings.filter((p) => p.active && p.critical).map((p) => p.name)).verdict : 'miss';
    const verdict = (body.verdict as 'full_day' | undefined) ?? computed;
    const insight = dayInsight(continuityView(s.graph.dayRecords, today()), verdict);
    const carryForward = typeof body.carryForward === 'string' && body.carryForward.trim() ? body.carryForward.trim() : undefined;
    patchDay({ closedAt: stamp(), verdict, computedVerdict: computed, insight, ...(typeof body.note === 'string' ? { note: body.note } : {}), ...(carryForward ? { carryForward } : {}), ...(Array.isArray(body.pillarReview) ? { pillarReview: body.pillarReview as never } : {}) });
    return { ...userState(), verdict, computedVerdict: computed, insight, carryForward: carryForward ?? null };
  }
  if (is('POST', 'diary')) {
    graph({ diaryEntries: [...s.graph.diaryEntries, { id: id(), userId: USER, kind: body.kind as 'diary', body: String(body.body ?? ''), localDay: today(), createdAt: stamp() }] });
    return { ...userState(), reply: 'Logged. It will show up in your weekly debrief.' };
  }
  if (is('GET', 'reviews/weekly')) { const state = userState(); return { debrief: debrief(state), due: state.today?.weeklyReview }; }
  if (is('POST', 'reviews/weekly')) {
    const summary = debrief(userState());
    const state = graph({ weeklyReviews: [...s.graph.weeklyReviews, { id: id(), userId: USER, weekStart: summary.weekStart, summary: {}, completedAt: stamp(), ...(typeof body.adjustment === 'string' ? { adjustment: body.adjustment } : {}) }] });
    return { ...state, debrief: summary };
  }
  if (is('POST', 'body/clearance')) return os({ clinicianClearedAt: stamp() });

  // Goals
  if (is('POST', 'goals')) {
    const goal: Goal = { id: id(), userId: USER, title: String(body.title ?? 'New goal'), status: 'active', health: 'unknown', priority: s.graph.goals.length + 1, provenance: stated(), ...(typeof body.outcome === 'string' ? { outcome: body.outcome } : {}), ...(body.pillar ? { pillar: body.pillar as AreaKey } : {}), ...(typeof body.targetDate === 'string' ? { targetDate: body.targetDate } : {}) };
    return { ...graph({ goals: [...s.graph.goals, goal] }), goalId: goal.id, arbitration: null, recommendedForegroundGoalId: null };
  }
  if (is('POST', 'goals/*/foreground')) return os({ foregroundGoalId: seg[1] });
  if (is('POST', 'goal-plans/*/gate-review')) return userState();
  if (is('POST', 'goal-plans/*/decision')) return graph({ goalPlans: s.graph.goalPlans.map((plan) => (plan.id === seg[1] ? { ...plan, status: 'decided' as const, decision: body.decision as 'maintain', decisionReason: String(body.reason ?? ''), decidedAt: stamp() } : plan)) });

  // Drafting Room
  if (is('POST', 'os/changes')) {
    const change = { id: id(), userId: USER, field: body.field as 'north_star', proposed: body.value, status: 'draft' as const, createdAt: stamp(), ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) };
    return { ...graph({ osChanges: [...s.graph.osChanges, change] }), change: { id: change.id } };
  }
  if (is('POST', 'os/changes/*/apply') || is('POST', 'os/changes/*/discard')) {
    const applied = seg[3] === 'apply';
    const change = s.graph.osChanges.find((item) => item.id === seg[2]);
    s.graph = { ...s.graph, osChanges: s.graph.osChanges.map((item) => (item.id === seg[2] ? { ...item, status: applied ? 'applied' as const : 'discarded' as const, ...(applied ? { appliedAt: stamp(), effectiveFrom: today() } : {}) } : item)) };
    if (applied && change && s.graph.personalOS) {
      const value = change.proposed;
      if (change.field === 'north_star') os({ northStar: String(value) });
      if (change.field === 'morning_sequence') os({ morningSequence: value as string[] });
      if (change.field === 'hard_boundaries') os({ hardBoundaries: value as string[] });
      if (change.field === 'non_negotiables') os({ nonNegotiables: value as string[] });
      if (change.field === 'core_values') os({ values: value as string[] });
      if (change.field === 'day_start') os({ accountability: { ...s.graph.personalOS.accountability, dayStart: value as 'guided' } });
      if (change.field === 'coaching_firmness') os({ coachingStyle: { ...s.graph.personalOS.coachingStyle, firmness: value as 'direct' } });
    }
    return applied ? { ...userState(), message: 'Applied. It takes effect from tomorrow’s agenda.' } : userState();
  }

  // Coach
  if (is('POST', 'apm/coach')) return coachTurn(body as never);
  if (is('POST', 'apm/coach/report')) return { reportId: id() };
  if (is('POST', 'apm/coach/*/close')) { s.coach = undefined; return { ok: true }; }

  // Life areas
  if (is('POST', 'life-os/relationships')) {
    const person = { id: id(), userId: USER, name: String(body.personName ?? 'Someone'), provenance: stated(), ...(typeof body.relationship === 'string' ? { relationship: body.relationship } : {}) };
    return graph({ people: [...s.graph.people, person], lifeRelationships: [...s.graph.lifeRelationships, { id: id(), userId: USER, personId: person.id, provenance: stated(), createdAt: stamp(), updatedAt: stamp(), ...(typeof body.birthday === 'string' ? { birthday: body.birthday } : {}), ...(typeof body.cadenceDays === 'number' ? { cadenceDays: body.cadenceDays } : {}), ...(typeof body.notes === 'string' ? { notes: body.notes } : {}) }] });
  }
  if (is('PATCH', 'life-os/relationships/*')) return graph({ lifeRelationships: s.graph.lifeRelationships.map((item) => (item.id === seg[2] ? { ...item, ...(typeof body.notes === 'string' ? { notes: body.notes } : {}), ...(typeof body.birthday === 'string' ? { birthday: body.birthday } : {}), updatedAt: stamp() } : item)) });
  if (is('POST', 'life-os/items')) return graph({ lifeAdminItems: [...s.graph.lifeAdminItems, { id: id(), userId: USER, kind: body.kind as 'bill', title: String(body.title ?? 'Item'), status: (body.status as 'open') ?? 'open', importance: (body.importance as 3) ?? 3, recurrence: (body.recurrence as object) ?? {}, details: {}, provenance: stated(), createdAt: stamp(), updatedAt: stamp(), ...(typeof body.dueAt === 'string' ? { dueAt: body.dueAt } : {}), ...(typeof body.startsAt === 'string' ? { startsAt: body.startsAt } : {}), ...(typeof body.endsAt === 'string' ? { endsAt: body.endsAt } : {}), ...(typeof body.amountMinor === 'number' ? { amountMinor: body.amountMinor } : {}), ...(typeof body.currency === 'string' ? { currency: body.currency } : {}) }] });
  if (is('PATCH', 'life-os/items/*')) return graph({ lifeAdminItems: s.graph.lifeAdminItems.map((item) => (item.id === seg[2] ? { ...item, ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(body.status ? { status: body.status as 'open' } : {}), updatedAt: stamp() } : item)) });
  if (is('POST', 'life-os/items/*/complete')) return graph({ lifeAdminItems: s.graph.lifeAdminItems.map((item) => (item.id === seg[2] ? { ...item, status: 'completed' as const, completedAt: stamp() } : item)) });

  // Connections and permissions: real accounts are never connected from the preview
  if (is('POST', 'connections/oauth/start') || is('POST', 'connections/oauth/exchange') || is('POST', 'actions/prepare') || is('POST', 'actions/*/approve')) throw new ApiError(409, OFF);
  if (is('PATCH', 'connections/*')) return graph({ connections: s.graph.connections.map((item) => (item.id === seg[1] ? { ...item, ...(typeof body.label === 'string' ? { label: body.label } : {}) } : item)) });
  if (is('POST', 'connections/*/disconnect')) return graph({ connections: s.graph.connections.map((item) => (item.id === seg[1] ? { ...item, status: 'disconnected' as const } : item)) });
  if (is('POST', 'connections/*/reactivate')) return graph({ connections: s.graph.connections.map((item) => (item.id === seg[1] ? { ...item, status: 'connected' as const } : item)) });
  if (is('PUT', 'permissions/*/*')) {
    const existing = s.graph.permissions.find((p) => p.domain === seg[1] && p.actionType === seg[2]);
    const permission = { id: existing?.id ?? id(), userId: USER, domain: seg[1]!, actionType: seg[2]!, autonomyLevel: (body.autonomyLevel as AutonomyLevel) ?? 0, constraints: (body.constraints as Record<string, unknown>) ?? {}, enabled: true, grantedAt: stamp(), updatedAt: stamp() };
    graph({ permissions: [...s.graph.permissions.filter((p) => p.id !== permission.id), permission] });
    return { permission };
  }

  // Notifications, trust, data rights
  if (is('GET', 'notifications/preferences')) return { preferences: s.prefs };
  if (is('PUT', 'notifications/preferences')) {
    s.prefs = { ...s.prefs, ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}), ...(typeof body.morningPushEnabled === 'boolean' ? { morning_push_enabled: body.morningPushEnabled } : {}), ...(typeof body.wakeTime === 'string' ? { wake_time: body.wakeTime } : {}), ...(body.lockScreenDetail ? { lock_screen_detail: body.lockScreenDetail as 'minimal' } : {}), ...(body.quietHours ? { quiet_hours: body.quietHours as object } : {}) };
    return { preferences: s.prefs };
  }
  if (seg[0] === 'push') return { ok: true, queued: 0, sent: 0, suppressed: 0 };
  if (is('GET', 'trust/model-routes')) return { routes: [] };
  if (is('GET', 'trust/activity')) return { events: s.graph.personalOS ? ACTIVITY.map(([event_type, actor_type, summary], index) => ({ id: `sample-${index}`, event_type, actor_type, metadata: { summary, sample: true }, created_at: stamp() })) : [] };
  if (is('POST', 'privacy/export')) return { job: { id: id(), status: 'complete' }, export: { generatedAt: stamp(), lifeGraph: userState().graph, activity: [] } };
  if (is('POST', 'privacy/delete')) { removeSync(KEY); s = fresh(); return { job: { id: 'preview', status: 'complete' }, status: 'deleted', note: 'Sample data cleared from this browser.' }; }
  if (is('GET', 'privacy/life-os')) return { lifeRelationships: s.graph.lifeRelationships, lifeAdminItems: s.graph.lifeAdminItems };
  if (is('GET', 'privacy/autopilot')) return { rules: s.rules, executions: [], masterPaused: s.autopilotPaused };
  if (is('GET', 'households')) return { households: [], members: [], items: [] };
  if (is('POST', 'households')) return { householdId: id() };

  // Autopilot: rules can be granted and paused; nothing ever runs
  if (is('GET', 'autopilot')) return autopilot();
  if (is('GET', 'autopilot/done')) return { day: new URLSearchParams(query).get('day') ?? today(), items: [] };
  if (is('PUT', 'autopilot/pause')) { s.autopilotPaused = Boolean(body.paused); return { paused: s.autopilotPaused }; }
  if (is('POST', 'autopilot/rules')) {
    const rule: AutopilotRule = { id: id(), userId: USER, actionClass: body.actionClass as 'calendar.create', status: 'active', constraints: body.constraints as AutopilotRule['constraints'], version: 1, grantedAt: stamp(), expiresAt: String(body.expiresAt), createdAt: stamp(), updatedAt: stamp() };
    s.rules = [...s.rules, rule];
    return { rule };
  }
  if (seg[0] === 'autopilot' && seg[1] === 'rules' && seg[2]) {
    if (seg[3] === 'run') throw new ApiError(409, OFF);
    const current = s.rules.find((item) => item.id === seg[2]);
    if (!current) throw new ApiError(404, {});
    const rule: AutopilotRule = {
      ...current, version: current.version + 1, updatedAt: stamp(),
      ...(seg[3] === 'pause' ? { status: 'paused' as const, pausedAt: stamp() } : {}), ...(seg[3] === 'resume' ? { status: 'active' as const } : {}), ...(seg[3] === 'revoke' ? { status: 'revoked' as const, revokedAt: stamp() } : {}),
      ...(!seg[3] && body.constraints ? { constraints: body.constraints as AutopilotRule['constraints'] } : {}), ...(!seg[3] && typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
    };
    s.rules = s.rules.map((item) => (item.id === rule.id ? rule : item));
    return { rule };
  }
  if (is('PUT', 'autopilot/flexible-events/*')) return { eventId: seg[2], flexible: Boolean(body.flexible) };
  if (is('POST', 'autopilot/executions/*/undo')) throw new ApiError(409, OFF);

  // Anything else: reads answer empty, changes answer the unchanged Today (analytics, syncs, attach).
  return method === 'GET' ? {} : userState();
}

/** The one entry point (src/api/apmApi.ts request). Never touches the network. */
export async function previewRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const body = typeof options.body === 'string' && options.body ? JSON.parse(options.body) as Record<string, unknown> : {};
  try { return JSON.parse(JSON.stringify(route(options.method ?? 'GET', path, body ?? {}))) as T; }
  finally { save(); }
}
