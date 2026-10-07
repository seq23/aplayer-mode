import { Hono } from 'hono';
import { z } from 'zod';
import { buildDailyPlan, reprintAgenda, weeklyDebrief, carryForwardProblem, continuityView, dayInsight, midDayReplanDecision, selectForeground, verdictFromReview } from '@apm/planning';
import { buildRadarItems } from '@apm/radar';
import type { ActionRecord, AutonomyLevel, OperatingModeKey, SubscriptionEntitlement } from '@apm/domain';
import { autonomyLabels, capabilitiesForPlan, forbiddenStandingActions, localMoment, maxAutonomyForPlan, planHasCapability, planPriceLabels, productPlanPolicies, standingActionClasses, STANDING_RULE_MAX_DAYS, validateStandingConstraints, type ActionDomain, type ProductPlan } from '@apm/policy';
import { authenticateRequest } from './auth';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';
import {
  completeNextAction,
  getLifeGraph,
  saveMethodologyIntake,
  saveOnboarding,
} from './lifeGraphRepository';
import {
  closeDay,
  getAuditEvents,
  getHouseholdInterest,
  getLifeOsExportState,
  listModelRoutes,
  recordAnalyticsEvent,
  registerPushSubscription,
  requestDataRightsJob,
  setHouseholdInterest,
  upsertPermission,
} from './platformRepository';
import {
  completeLifeAdminItem,
  lifeOsErrorResponse,
  createLifeAdminItem,
  createRelationship,
  updateLifeAdminItem,
  updateRelationship,
} from './lifeOsRepository';
import { createOAuthState, verifyOAuthState } from './crypto';
import { buildOAuthAuthorizationUrl, exchangeAndStoreOAuthConnection } from './connectors/oauth';
import { syncCloudCalendar, syncDeviceCalendar } from './connectors/calendar';
import { syncEmailSignals } from './connectors/email';
import { closeCoachingSession, coach } from './coaching';
import { COACH_CHOICES } from './coach/machine';
import { applyModeToPlan, modeView, reconcileModeState, transitionMode, type ModeEvent, type ModeRequest, type ModeState } from './coach/modes';
import { ACTIVE_TRACK_KEYS } from './coach/tracks';
import { getModeState, saveModeState } from './modeRepository';
import { approveAndMaybeExecuteAction, prepareAction } from './actionEngine';
import {
  autopilotErrorResponse,
  getAutopilotDoneList,
  getAutopilotExportState,
  getAutopilotState,
  grantAutopilotRule,
  hasAutopilotAccess,
  revokeAutopilotRule,
  runStandingRule,
  setAutopilotEventFlexible,
  setAutopilotMasterPause,
  setAutopilotRuleStatus,
  undoStandingExecution,
  updateAutopilotRule,
} from './autopilotRepository';
import { notifyRadarItems } from './push';
import { workPushHold } from './morningTrigger';
import { buildGoalPlan, criticalPillars, ensureGoalPlans, pauseBodyCoachingIfFlagged, pillarRebuildsPending, rebuildBodyPlans, redactForHardStart, trackContext, freshAgenda, localToday, planEntries, todayLoopState } from './dailyLoop';
import {
  applyOsChange,
  asLoopError,
  discardOsChange,
  draftOsChange,
  logDiary,
  recordClinicianClearance,
  reprintDay,
  returnResetDay,
  saveWeeklyReview,
  setDayPhase,
  checkInDay,
  closeDayReview,
  completePlanAction,
  createGoalWithPlan,
  decideGoalPlan,
  getDailyLoopExportState,
  loopErrorResponse,
  replanDay,
  reviewGoalPlanGate,
  saveGoalPlan,
  setForegroundGoal,
} from './dailyLoopRepository';

type WorkerEnv = { Bindings: ApiEnv };
const app = new Hono<WorkerEnv>();

const pillarSchema = z.enum(['wealth', 'body', 'spirit', 'execution']);
const trackSchema = z.enum(ACTIVE_TRACK_KEYS);
const modeSchema = z.enum(['standard','recovery','high_pressure','executive_review','sprint','deep_work']);
const providerSchema = z.enum(['google','microsoft']);
const integrationKindSchema = z.enum(['calendar','email']);

function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  );
}

const dateOnlySchema = z.string().refine(isValidDateOnly, { message: 'invalid calendar date' });

const onboardingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  primaryGoal: z.string().trim().min(5).max(500),
  currentSeason: z.string().trim().max(240).optional(),
  becoming: z.string().trim().max(500).optional(),
  pillar: pillarSchema.optional(),
});



function entitlementIsUsable(entitlement: SubscriptionEntitlement | undefined): boolean {
  return Boolean(entitlement && (entitlement.status === 'active' || entitlement.status === 'trialing'));
}

function hasLifeOsAccess(entitlement: SubscriptionEntitlement | undefined): boolean {
  return Boolean(
    entitlement
    && entitlementIsUsable(entitlement)
    && entitlement.plan !== 'household'
    && planHasCapability(entitlement.plan, 'life_os_domains'),
  );
}

function planResponse(entitlement: SubscriptionEntitlement | undefined, userId: string) {
  const raw: SubscriptionEntitlement = entitlement ?? { userId, plan: 'beta', status: 'active' };
  const resolved: SubscriptionEntitlement = raw.plan === 'household' ? { ...raw, plan: 'autopilot' } : raw;
  const usable = entitlementIsUsable(resolved);
  const policy = productPlanPolicies[resolved.plan];
  const maxAutonomyLevel = usable ? maxAutonomyForPlan(resolved.plan, 'calendar') : 0;
  return {
    entitlement: {
      ...resolved,
      displayName: policy.displayName,
      promise: policy.promise,
      capabilities: usable ? capabilitiesForPlan(resolved.plan) : [],
      maxAutonomyLevel,
      maxAutonomyLabel: autonomyLabels[maxAutonomyLevel],
    },
    plans: (Object.keys(productPlanPolicies) as ProductPlan[]).map((plan) => {
      const item = productPlanPolicies[plan];
      const level = maxAutonomyForPlan(plan, 'calendar');
      return {
        plan,
        displayName: item.displayName,
        promise: item.promise,
        publicAvailability: item.publicAvailability,
        capabilities: capabilitiesForPlan(plan),
        maxAutonomyLevel: level,
        maxAutonomyLabel: autonomyLabels[level],
        priceLabel: planPriceLabels[plan],
        highlights: plan === 'chief_of_staff'
          ? ['Today + Radar + coaching', 'Calendar/email awareness', 'Prepare supported actions']
          : plan === 'life_os'
            ? ['Everything in Chief of Staff', 'Life-management domains', 'Execute one explicitly approved action']
            : plan === 'autopilot'
              ? ['Everything in Life OS', 'Standing authority inside rules you set', 'Revocable domain-by-domain control']
              : plan === 'household'
                ? ['Future shared household coordination', 'Interest list only — no access granted']
                : ['Chief-of-Staff capability ceiling during beta'],
      };
    }),
  };
}

const methodologyIntakeSchema = onboardingSchema.extend({
  timezone: z.string().trim().max(120).optional(),
  goalOutcome: z.string().trim().max(800).optional(),
  goalTargetDate: dateOnlySchema.optional(),
  firstNextAction: z.string().trim().min(3).max(500).optional(),
  northStar: z.string().trim().max(1000).optional(),
  values: z.array(z.string().trim().min(1).max(160)).max(20),
  nonNegotiables: z.array(z.string().trim().min(1).max(240)).max(20),
  failurePatterns: z.array(z.string().trim().min(1).max(300)).max(20),
  bodyContext: z.string().trim().max(1200).optional(),
  workMoneyContext: z.string().trim().max(1200).optional(),
  mindSpiritLearningContext: z.string().trim().max(1200).optional(),
  weeklyCadence: z.object({
    heavyDays: z.array(z.string().trim().min(1).max(20)).max(7),
    lightDays: z.array(z.string().trim().min(1).max(20)).max(7),
    reviewDay: z.string().trim().max(20).optional(),
    recoveryDay: z.string().trim().max(20).optional(),
  }),
  coachingStyle: z.object({
    firmness: z.enum(['gentle','direct','high_pressure']),
    helpfulLanguage: z.string().trim().max(500).optional(),
    avoidLanguage: z.string().trim().max(500).optional(),
  }),
  accountability: z.object({ dayStart: z.enum(['guided','hard']), coachingReminderAfterDays: z.number().int().min(1).max(60).optional() }),
  criticalPillars: z.array(pillarSchema).max(4),
  minimumFloors: z.object({ wealth: z.string().trim().max(300).optional(), body: z.string().trim().max(300).optional(), spirit: z.string().trim().max(300).optional(), execution: z.string().trim().max(300).optional() }),
  trackKeys: z.array(trackSchema).max(ACTIVE_TRACK_KEYS.length),
  // Sprint and Deep Work need a declared duration, so they start only via POST /v1/methodology/mode.
  activeMode: z.enum(['standard','recovery','high_pressure','executive_review']).optional(),
  morningSequence: z.array(z.string().trim().min(1).max(240)).max(5).optional(),
  schedulingPreference: z.enum(['strict_blocks','loose_dayparts','ordered_stack']).optional(),
  hardBoundaries: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  scoringConfig: z.object({ enabled: z.boolean(), showSevenDaySnapshot: z.boolean() }).optional(),
  foregroundProjectName: z.string().trim().max(300).optional(),
  foregroundProjectObjective: z.string().trim().max(800).optional(),
  reviewGateDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
});

const lifeAdminKindSchema = z.enum([
  'appointment','trip','bill','subscription','meal_plan','shopping',
  'health_routine','recurring_obligation','family_obligation',
]);
const lifeAdminStatusSchema = z.enum(['open','planned','scheduled','completed','paused','cancelled']);
const lifeAdminMutableStatusSchema = z.enum(['open','planned','scheduled','paused','cancelled']);
const lifeAdminRecurrenceSchema = z.object({
  frequency: z.enum(['daily','weekly','monthly','yearly']).optional(),
  interval: z.number().int().min(1).max(365).optional(),
}).default({});
const optionalDateSchema = z.union([dateOnlySchema, z.literal('')]).optional();
const optionalDateTimeSchema = z.union([z.string().datetime(), z.literal('')]).optional();

const relationshipCreateSchema = z.object({
  personId: z.string().uuid().optional(),
  personName: z.string().trim().min(1).max(200).optional(),
  relationship: z.string().trim().max(120).optional(),
  email: z.union([z.string().email().max(320), z.literal('')]).optional(),
  phone: z.string().trim().max(80).optional(),
  birthday: optionalDateSchema,
  nextContactAt: optionalDateTimeSchema,
  cadenceDays: z.number().int().min(1).max(3650).optional(),
  notes: z.string().max(4000).optional(),
}).superRefine((value, ctx) => {
  if (!value.personId && !value.personName) ctx.addIssue({ code: 'custom', message: 'personId or personName is required' });
});

const relationshipPatchSchema = z.object({
  personName: z.string().trim().min(1).max(200).optional(),
  relationship: z.string().trim().max(120).optional(),
  email: z.union([z.string().email().max(320), z.literal('')]).optional(),
  phone: z.string().trim().max(80).optional(),
  birthday: optionalDateSchema,
  nextContactAt: optionalDateTimeSchema,
  cadenceDays: z.number().int().min(1).max(3650).nullable().optional(),
  notes: z.string().max(4000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const lifeAdminCreateSchema = z.object({
  personId: z.string().uuid().optional(),
  kind: lifeAdminKindSchema,
  title: z.string().trim().min(1).max(500),
  status: lifeAdminMutableStatusSchema.optional(),
  importance: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]).optional(),
  dueAt: z.string().datetime().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  recurrence: lifeAdminRecurrenceSchema.optional(),
  amountMinor: z.number().int().min(0).max(9_000_000_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.startsAt && value.endsAt && Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
    ctx.addIssue({ code: 'custom', message: 'endsAt must be at or after startsAt' });
  }
});

const lifeAdminPatchSchema = z.object({
  personId: z.union([z.string().uuid(), z.literal('')]).optional(),
  kind: lifeAdminKindSchema.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  status: lifeAdminMutableStatusSchema.optional(),
  importance: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]).optional(),
  dueAt: optionalDateTimeSchema,
  startsAt: optionalDateTimeSchema,
  endsAt: optionalDateTimeSchema,
  recurrence: lifeAdminRecurrenceSchema.optional(),
  amountMinor: z.number().int().min(0).max(9_000_000_000_000).nullable().optional(),
  currency: z.union([z.string().regex(/^[A-Z]{3}$/), z.literal('')]).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

// Phase C — Autopilot standing rules. Shapes mirror migration 0018; the
// database stays authoritative and re-validates everything.
const standingWindowSchema = {
  timezone: z.string().trim().min(1).max(120),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  windowStart: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  windowEnd: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
};
const calendarConstraintsSchema = z.object({
  ...standingWindowSchema,
  maxDurationMinutes: z.number().int().min(15).max(240),
  maxPerDay: z.number().int().min(1).max(10),
  horizonDays: z.number().int().min(1).max(30),
  collision: z.literal('never_overlap_busy'),
}).strict();
const emailDraftConstraintsSchema = z.object({
  ...standingWindowSchema,
  maxPerDay: z.number().int().min(1).max(20),
  allowedRecipientDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).min(1).max(10),
}).strict();
const expiresAtSchema = z.string().datetime().refine((value) => {
  const ms = Date.parse(value) - Date.now();
  return ms > 3_600_000 && ms <= STANDING_RULE_MAX_DAYS * 86_400_000;
}, { message: `expiresAt must be between 1 hour and ${STANDING_RULE_MAX_DAYS} days ahead` });
// Header-safe single-line text: CR/LF or any control character could inject MIME headers.
const headerSafe = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: 'control characters are not allowed' });
const lowerList = (max: number, len: number) => z.array(z.string().trim().toLowerCase().min(1).max(len)).max(max);
const criteriaSchema = {
  matchTitleKeywords: lowerList(10, 60),
  maxAttendees: z.number().int().min(0).max(50),
  protectedTitleKeywords: lowerList(10, 60),
};
const emailSendConstraintsSchema = z.object({
  ...standingWindowSchema,
  maxPerDay: z.number().int().min(1).max(20),
  maxPerRecipientPerDay: z.number().int().min(1).max(3),
  allowedKinds: z.array(z.enum(['scheduling_reply','follow_up','confirmation','template'])).min(1).max(4),
  allowedRecipients: z.array(z.string().trim().toLowerCase().email().max(320)).max(25),
  allowedRecipientDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(10),
  templates: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: headerSafe(80), subject: headerSafe(300), body: z.string().min(1).max(5000) }).strict()).max(10),
}).strict();
const rescheduleConstraintsSchema = z.object({
  ...standingWindowSchema, ...criteriaSchema,
  maxPerDay: z.number().int().min(1).max(10),
  horizonDays: z.number().int().min(1).max(30),
  maxShiftDays: z.number().int().min(0).max(7),
  collision: z.literal('never_overlap_busy'),
}).strict();
const declineConstraintsSchema = z.object({
  timezone: standingWindowSchema.timezone, ...criteriaSchema,
  maxPerDay: z.number().int().min(1).max(10),
  horizonDays: z.number().int().min(1).max(30),
  boundaries: z.array(z.object({ weekdays: standingWindowSchema.weekdays, start: standingWindowSchema.windowStart, end: standingWindowSchema.windowEnd }).strict()).min(1).max(10),
  declineNote: headerSafe(500).optional(),
}).strict();
const appointmentConstraintsSchema = z.object({
  ...standingWindowSchema,
  maxPerDay: z.number().int().min(1).max(3),
  horizonDays: z.number().int().min(1).max(60),
  providers: z.array(z.object({
    email: z.string().trim().toLowerCase().email().max(320),
    label: headerSafe(80),
    category: z.enum(['medical','dental','vision','therapy','vet','personal_care','auto','home','other']),
    appointmentTypes: z.array(headerSafe(80)).min(1).max(5),
  }).strict()).min(1).max(10),
}).strict();
const subscriptionCancelConstraintsSchema = z.object({
  timezone: standingWindowSchema.timezone,
  maxPerDay: z.number().int().min(1).max(5),
  allowedProviderDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).min(1).max(10),
}).strict();
const autopilotGrantSchema = z.discriminatedUnion('actionClass', [
  z.object({ actionClass: z.literal('calendar.create'), constraints: calendarConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('email.draft'), constraints: emailDraftConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('email.send'), constraints: emailSendConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('calendar.reschedule'), constraints: rescheduleConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('calendar.decline'), constraints: declineConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('appointment.book'), constraints: appointmentConstraintsSchema, expiresAt: expiresAtSchema }),
  z.object({ actionClass: z.literal('subscription.cancel'), constraints: subscriptionCancelConstraintsSchema, expiresAt: expiresAtSchema }),
]);
const autopilotUpdateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  constraints: z.record(z.string(), z.unknown()).optional(),
  expiresAt: expiresAtSchema.optional(),
}).refine((value) => value.constraints !== undefined || value.expiresAt !== undefined, { message: 'constraints or expiresAt is required' });
const autopilotVersionSchema = z.object({ expectedVersion: z.number().int().min(1) });
const autopilotRunBaseSchema = { idempotencyKey: z.string().min(8).max(200), reason: z.string().trim().min(3).max(1000) };
const autopilotRunPayloadSchemas = {
  'calendar.create': z.object({
    connectionId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    location: z.string().max(300).optional(),
  }).strict(),
  'email.draft': z.object({
    connectionId: z.string().uuid(),
    to: z.string().email().max(320),
    // The subject becomes a MIME header; control characters could inject recipients.
    subject: z.string().trim().min(1).max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: 'control characters are not allowed' }),
    body: z.string().max(10000),
  }).strict(),
  // Rule-defined kinds only; the database binds each kind to a real source.
  'email.send': z.discriminatedUnion('kind', [
    z.object({ connectionId: z.string().uuid(), kind: z.literal('template'), to: z.string().email().max(320), templateId: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict(),
    z.object({ connectionId: z.string().uuid(), kind: z.literal('follow_up'), to: z.string().email().max(320), subject: headerSafe(300), body: z.string().trim().min(1).max(5000), commitmentId: z.string().uuid() }).strict(),
    z.object({ connectionId: z.string().uuid(), kind: z.enum(['scheduling_reply','confirmation']), to: z.string().email().max(320), subject: headerSafe(300), body: z.string().trim().min(1).max(5000), sourceSignalId: z.string().uuid() }).strict(),
  ]),
  'calendar.reschedule': z.object({ eventId: z.string().uuid(), startsAt: z.string().datetime(), endsAt: z.string().datetime() }).strict(),
  'calendar.decline': z.object({ eventId: z.string().uuid() }).strict(),
  // No free text: the request is composed by the database from the rule.
  'appointment.book': z.object({
    connectionId: z.string().uuid(), providerEmail: z.string().email().max(320), appointmentType: headerSafe(80),
    startsAt: z.string().datetime(), endsAt: z.string().datetime(), paymentRequired: z.boolean(), sourceSignalId: z.string().uuid().optional(),
  }).strict(),
  'subscription.cancel': z.discriminatedUnion('route', [
    z.object({ connectionId: z.string().uuid(), lifeAdminItemId: z.string().uuid(), route: z.literal('email'), cancelEmail: z.string().email().max(320), accountRef: headerSafe(120).optional() }).strict(),
    z.object({ connectionId: z.string().uuid(), lifeAdminItemId: z.string().uuid(), route: z.literal('web') }).strict(),
  ]),
} as const;

const deviceCalendarEventSchema = z.object({
  provider: z.string().default('device'), externalEventId: z.string().min(1).max(500), calendarExternalId: z.string().max(500).optional(),
  title: z.string().max(1000).default(''), location: z.string().max(1000).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(),
  timezone: z.string().max(120).optional(), allDay: z.boolean(), availability: z.enum(['free','busy','tentative','out_of_office']).default('busy'),
  recurrence: z.record(z.string(), z.unknown()).optional(), organizer: z.record(z.string(), z.unknown()).optional(), attendees: z.array(z.unknown()).optional(),
  sourceVersion: z.string().max(500).optional(), deleted: z.boolean().optional(),
});

async function persistModeEvents(env: ApiEnv, accessToken: string, userId: string, events: ModeEvent[], state: ModeState, actor: 'user' | 'system') {
  if (!events.length) return;
  await supabaseRest(env, accessToken, '/rest/v1/audit_events', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(events.map((event) => ({ user_id: userId, event_type: event, actor_type: actor, object_type: 'personal_os', object_id: userId, metadata: { mode: state.mode, endsAt: state.endsAt ?? null, recoveryLockedUntil: state.recoveryLockedUntil ?? null } }))),
  });
}

/** Mode auto-exit (Deep Work block end, Sprint end → mandatory recovery, declared Recovery return) is applied on every read. */
async function currentModeState(env: ApiEnv, accessToken: string, userId: string, timezone: string | undefined, now: Date): Promise<ModeState> {
  const stored = await getModeState(env, accessToken, userId);
  const reconciled = reconcileModeState(stored, now, timezone);
  if (reconciled.changed) {
    await saveModeState(env, accessToken, reconciled.state);
    await persistModeEvents(env, accessToken, userId, reconciled.events, reconciled.state, 'system');
  }
  return reconciled.state;
}

async function buildUserState(env: ApiEnv, accessToken: string, userId: string) {
  const now = new Date();
  const persistedGraph = await ensureGoalPlans(env, accessToken, await getLifeGraph(env, accessToken, userId), now);
  const modeState = persistedGraph.personalOS
    ? await currentModeState(env, accessToken, userId, persistedGraph.identity.timezone, now)
    : { mode: 'standard' as const };
  const graph = {
    ...persistedGraph,
    personalOS: persistedGraph.personalOS ? { ...persistedGraph.personalOS, activeMode: modeState.mode } : undefined,
    radarItems: buildRadarItems(persistedGraph),
  };
  const projected = applyModeToPlan(buildDailyPlan(graph, { mode: modeState.mode === 'recovery' ? 'recovery' : undefined, now }), graph, modeState);
  const lastCoaching = persistedGraph.personalOS
    ? await supabaseRest<Array<{ started_at: string }>>(env, accessToken, `/rest/v1/coaching_sessions?user_id=eq.${encodeURIComponent(userId)}&select=started_at&order=started_at.desc&limit=1`).catch(() => [])
    : [];
  const today = redactForHardStart(todayLoopState(graph, { now, recoveryMode: modeState.mode === 'recovery', lastCoachingAt: lastCoaching[0]?.started_at }));
  return { graph, plan: projected.plan, mode: { ...modeView(modeState, now), todayEffect: projected.effect }, today };
}

function loopFailure(c: any, error: unknown) {
  const mapped = loopErrorResponse(error);
  if (!mapped) throw error;
  return c.json({ error: mapped.error, message: mapped.message }, mapped.status);
}

async function requireUser(c: any) {
  const user = await authenticateRequest(c.req.raw, c.env as ApiEnv);
  return user;
}

async function audit(env: ApiEnv, accessToken: string, userId: string, eventType: string, metadata: Record<string, unknown> = {}, objectType?: string, objectId?: string) {
  await supabaseRest(env, accessToken, '/rest/v1/audit_events', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ user_id: userId, event_type: eventType, actor_type: 'user', object_type: objectType ?? null, object_id: objectId ?? null, metadata }]),
  });
}

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.header('x-request-id', requestId);
  c.header('cache-control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (c.env.ALLOWED_ORIGIN) {
    c.header('access-control-allow-origin', c.env.ALLOWED_ORIGIN);
    c.header('access-control-allow-headers', 'authorization, content-type, x-request-id');
    c.header('access-control-allow-methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/v1/health', (c) => c.json({ ok: true, service: 'aplayer-mode-api', dataPlatform: 'supabase', time: new Date().toISOString() }));

app.get('/v1/me/life-graph', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { graph } = await buildUserState(c.env, user.accessToken, user.id); return c.json({ graph });
});
app.get('/v1/me/today', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.get('/v1/product/plan', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  return c.json(planResponse(graph.entitlement, user.id));
});

app.get('/v1/product/household-interest', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await getHouseholdInterest(c.env, user.accessToken, user.id));
});

app.put('/v1/product/household-interest', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ interested: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const result = await setHouseholdInterest(c.env, user.accessToken, user.id, parsed.data.interested);
  await audit(c.env, user.accessToken, user.id, 'product_interest.changed', { interest: 'household', interested: result.interested }, 'product_interest', 'household');
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'household_interest_changed', { interested: result.interested });
  return c.json(result);
});

app.post('/v1/life-os/relationships', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = relationshipCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const created = await createRelationship(c.env, user.accessToken, user.id, parsed.data);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_relationship_saved');
    return c.json(await buildUserState(c.env, user.accessToken, user.id), 201);
  } catch (error) {
    const mapped = lifeOsErrorResponse(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

app.patch('/v1/life-os/relationships/:id', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = relationshipPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const relationship = await updateRelationship(c.env, user.accessToken, user.id, c.req.param('id'), parsed.data);
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    const mapped = lifeOsErrorResponse(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

app.post('/v1/life-os/items', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = lifeAdminCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const item = await createLifeAdminItem(c.env, user.accessToken, user.id, parsed.data, before.identity.timezone);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_item_created', { kind: item.kind });
    return c.json(await buildUserState(c.env, user.accessToken, user.id), 201);
  } catch (error) {
    const mapped = lifeOsErrorResponse(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

app.patch('/v1/life-os/items/:id', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = lifeAdminPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const item = await updateLifeAdminItem(c.env, user.accessToken, user.id, c.req.param('id'), parsed.data, before.identity.timezone);
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    const mapped = lifeOsErrorResponse(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

app.post('/v1/life-os/items/:id/complete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const item = await completeLifeAdminItem(c.env, user.accessToken, user.id, c.req.param('id'), before.identity.timezone);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_item_completed', { kind: item.kind, recurring: Boolean(item.recurrence.frequency) });
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    const mapped = lifeOsErrorResponse(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

app.put('/v1/onboarding', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = onboardingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, 400);
  await saveOnboarding(c.env, user.accessToken, user.id, parsed.data);
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'onboarding_completed');
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.put('/v1/methodology/intake', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = methodologyIntakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, 400);
  const installed = await saveMethodologyIntake(c.env, user.accessToken, user.id, parsed.data);
  await audit(c.env, user.accessToken, user.id, 'personal_os.installed', { roles: parsed.data.roles.length, trackCount: parsed.data.trackKeys.length }, 'personal_os', user.id);
  // Goal → plan at intake: the primary goal gets its 30/60/90 plan now (a re-run intake replaces it).
  const primary = installed.goals.find((goal) => goal.id === installed.personalOS?.foregroundGoalId)
    ?? installed.goals.find((goal) => goal.status === 'active' && goal.priority === 1);
  if (primary) {
    try {
      await saveGoalPlan(c.env, user.id, primary.id, buildGoalPlan(installed, primary, new Date()), 'intake');
      // A red flag in the intake's body context persists the pause until clinician clearance.
      await pauseBodyCoachingIfFlagged(c.env, user.accessToken, user.id, [parsed.data.bodyContext], 'intake', new Date());
    } catch (error) { return loopFailure(c, error); }
  }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

const modeRequestSchema = z.union([
  z.object({ action: z.literal('exit') }),
  z.object({ action: z.literal('enter').default('enter'), mode: z.enum(['standard','high_pressure','executive_review','recovery']) }),
  z.object({ action: z.literal('enter').default('enter'), mode: z.literal('sprint'), days: z.number().int().min(1).max(14) }),
  z.object({ action: z.literal('enter').default('enter'), mode: z.literal('deep_work'), minutes: z.number().int().min(15).max(240), focus: z.string().trim().min(1).max(200) }),
]);

async function changeMode(env: ApiEnv, accessToken: string, userId: string, request: ModeRequest) {
  const now = new Date();
  const graph = await getLifeGraph(env, accessToken, userId);
  if (!graph.personalOS) return { ok: false as const, error: 'personal_os_missing', message: 'Complete the Personal OS intake first.' };
  const current = await currentModeState(env, accessToken, userId, graph.identity.timezone, now);
  const foreground = graph.projects.find((project) => project.foreground && project.status === 'active');
  const result = transitionMode(current, request, { now, timezone: graph.identity.timezone, foregroundTitle: foreground?.title });
  if (!result.ok) return result;
  if (result.events.length) {
    await saveModeState(env, accessToken, result.state);
    await persistModeEvents(env, accessToken, userId, result.events, result.state, 'user');
  }
  return result;
}

app.post('/v1/methodology/mode', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = modeRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const result = await changeMode(c.env, user.accessToken, user.id, parsed.data as ModeRequest);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, 409);
  await audit(c.env, user.accessToken, user.id, 'operating_mode.changed', { mode: result.state.mode }, 'personal_os', user.id);
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/methodology/day/close', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ verdict: z.enum(['full_day','mvd','miss']), note: z.string().trim().max(1000).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  let row;
  try { row = await closeDay(c.env, user.accessToken, parsed.data.verdict, parsed.data.note); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ day: row, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

// ---------------------------------------------------------------- BHPC daily loop (migration 0021)
app.post('/v1/today/check-in', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ mood: z.number().int().min(1).max(10) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  if (!state.graph.personalOS) return c.json({ error: 'personal_os_missing', message: 'Complete the Personal OS intake first.' }, 409);
  if (state.today.checkedIn) return c.json({ replayed: true, ...state });
  // Never lock an agenda from a plan that has not received an in-effect pillar change yet.
  // Fail closed: if the check itself fails, the plans' state is unknown, so do not lock.
  if (await pillarRebuildsPending(c.env, user.id).catch(() => true)) {
    return c.json({ error: 'plans_updating', message: 'Your Drafting Room change is still reaching your plans. Try the check-in again in a moment.' }, 503);
  }
  // The Mood Gate runs here, in the morning: mood ≤ 2 prints a Minimum Viable Day.
  const agenda = freshAgenda(state.graph, { date: state.today.date, state: state.today.dayState.state, mood: parsed.data.mood });
  try { await checkInDay(c.env, user.id, { day: state.today.date, mood: parsed.data.mood, agenda }); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ replayed: false, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/today/actions/complete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ planId: z.string().uuid(), actionKey: z.string().trim().min(1).max(120), note: z.string().trim().max(500).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  let result;
  try { result = await completePlanAction(c.env, user.accessToken, parsed.data); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ replayed: result.replayed, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

const replanReasonSchema = z.enum(['external_change', 'safety', 'permission', 'mood', 'discomfort']);
app.post('/v1/today/replan', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ reason: replanReasonSchema, detail: z.string().trim().max(300).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const decision = midDayReplanDecision(parsed.data.reason);
  if (decision.allowed && !parsed.data.detail) {
    const graph = await getLifeGraph(c.env, user.accessToken, user.id);
    // Operator Discipline: a change is declared with a reason, never drifted into.
    if (graph.tracks.some((track) => track.active && track.key === 'operator_discipline')) {
      return c.json({ error: 'declare_the_change', message: 'Operator Discipline is active: say in one line what changed before the plan is reopened.' }, 409);
    }
  }
  if (!decision.allowed) {
    await audit(c.env, user.accessToken, user.id, 'day.replan_refused', { reason: parsed.data.reason }, 'day_record');
    return c.json({ error: decision.code, message: decision.message }, 409);
  }
  const state = await buildUserState(c.env, user.accessToken, user.id);
  if (!state.today.locked) return c.json({ error: 'opening_step_required', message: 'Check in first; the agenda is set at check-in.' }, 409);
  // A declared safety issue runs the rest of today at recovery scope; an external change keeps the day's state.
  const dayState = parsed.data.reason === 'safety' ? 'recovery' : state.today.agenda.state;
  const agenda = freshAgenda(state.graph, { date: state.today.date, state: dayState, mood: state.today.day?.mood });
  try { await replanDay(c.env, user.id, { day: state.today.date, reason: parsed.data.reason, detail: parsed.data.detail, agenda }); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ message: decision.message, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

// End-of-day check-in (BHPC Prompt #6): what was completed pillar by pillar, Hit /
// Partial / Miss, the verdict, the 7-day snapshot, one insight and one carry item.
app.post('/v1/today/close', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({
    pillarReview: z.array(z.object({ pillar: z.enum(['wealth', 'body', 'spirit', 'execution', 'family']), score: z.enum(['hit', 'partial', 'miss']), completed: z.string().trim().max(300).optional() })).min(1).max(5),
    verdict: z.enum(['full_day', 'mvd', 'miss']).optional(),
    note: z.string().trim().max(1000).optional(),
    carryForward: z.string().trim().max(200).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  if (new Set(parsed.data.pillarReview.map((entry) => entry.pillar)).size !== parsed.data.pillarReview.length) return c.json({ error: 'invalid_request', message: 'One score per pillar.' }, 400);
  const carry = parsed.data.carryForward?.trim() || undefined;
  const carryProblem = carry ? carryForwardProblem(carry) : null;
  if (carryProblem) return c.json({ error: 'invalid_carry_forward', message: carryProblem }, 400);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  const computedVerdict = verdictFromReview(parsed.data.pillarReview, criticalPillars(state.graph), state.today.agenda.mode === 'recovery');
  // The user has final authority over the verdict; the computed one is kept next to it.
  // Evidence before verdict: without the check-in the day can only close as a Miss.
  if (!state.today.checkedIn && parsed.data.verdict && parsed.data.verdict !== 'miss') {
    return c.json({ error: 'opening_step_required', message: 'A Full Day or MVD needs the check-in first. Without it, today closes as a Miss.' }, 409);
  }
  const hasEvidence = state.today.closePreview.evidence.length > 0;
  if (parsed.data.verdict && parsed.data.verdict !== 'miss' && !hasEvidence) {
    return c.json({ error: 'verdict_needs_evidence', message: 'A Full Day or MVD needs at least one completed action today. Otherwise close it as a Miss — a miss is data.' }, 409);
  }
  const items = [state.today.agenda.firstHour.priority, ...state.today.agenda.dailyStack].filter((item) => (item?.planId && item.actionKey) || item?.nextActionId);
  // A recovery agenda (MVD) closes as an MVD at most, whatever was done.
  const allDone = items.length > 0 && items.every((item) => item!.status === 'done') && state.today.agenda.mode !== 'recovery';
  if (parsed.data.verdict === 'full_day' && !allDone) {
    return c.json({ error: 'verdict_needs_evidence', message: 'A Full Day needs every agenda item done. Close it as an MVD — that still counts.' }, 409);
  }
  // Never claim more than the evidence: the computed verdict is capped the same way.
  const cappedComputed = computedVerdict === 'full_day' && !allDone ? (hasEvidence ? 'mvd' : 'miss') : computedVerdict;
  const verdict = state.today.checkedIn && hasEvidence ? parsed.data.verdict ?? cappedComputed : 'miss';
  const continuity = continuityView([{ day: state.today.date, verdict }, ...state.graph.dayRecords.filter((record) => record.day !== state.today.date)], state.today.date);
  const insight = dayInsight(continuity, verdict);
  try {
    await closeDayReview(c.env, user.accessToken, { verdict, computedVerdict: cappedComputed, pillarReview: parsed.data.pillarReview, note: parsed.data.note, carryForward: carry, insight });
    await pauseBodyCoachingIfFlagged(c.env, user.accessToken, user.id, [parsed.data.note], 'day_close', new Date());
  } catch (error) { return loopFailure(c, error); }
  return c.json({ verdict, computedVerdict: cappedComputed, insight, continuity, carryForward: carry ?? null, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

// ---------------------------------------------------------------- BHPC loop, part 3 (migration 0028)
app.post('/v1/diary', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ kind: z.enum(['diary', 'breakthrough', 'slip']).default('diary'), body: z.string().trim().min(1).max(4000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  let logged;
  try {
    logged = await logDiary(c.env, user.accessToken, parsed.data);
    // Silent logging still keeps people safe: a red flag pauses body coaching.
    await pauseBodyCoachingIfFlagged(c.env, user.accessToken, user.id, [parsed.data.body], 'diary', new Date());
  } catch (error) { return loopFailure(c, error); }
  return c.json({ reply: logged.reply, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/today/phase', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ phase: z.enum(['first_hour', 'executing']) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  try { await setDayPhase(c.env, user.accessToken, parsed.data.phase); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/today/return', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  try { await returnResetDay(c.env, user.accessToken); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/today/reprint', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ itemIds: z.array(z.string().min(1).max(300)).max(20).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  if (!state.today.locked) return c.json({ error: 'opening_step_required', message: 'Check in first; REPRINT works on the printed agenda.' }, 409);
  const result = reprintAgenda(state.today.agenda, planEntries(state.graph), parsed.data.itemIds ?? []);
  if (!result.replaced.length) return c.json({ error: 'nothing_to_reprint', message: 'Every item on today’s agenda is a physical action with an output and a time box.' }, 409);
  try { await reprintDay(c.env, user.id, { day: state.today.date, agenda: result.agenda }); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ replaced: result.replaced, stillInvalid: result.stillInvalid, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

function debriefFor(state: Awaited<ReturnType<typeof buildUserState>>) {
  const foreground = state.today.agenda.foregroundPriority;
  return weeklyDebrief({
    today: state.today.date,
    dayRecords: state.graph.dayRecords,
    completions: state.graph.planCompletions,
    ...(foreground ? { foreground: { planId: foreground.planId, label: foreground.label } } : {}),
    diary: state.graph.diaryEntries,
    trackFlags: state.today.agenda.trackFlags ?? [],
  });
}

app.get('/v1/reviews/weekly', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  return c.json({ debrief: debriefFor(state), due: state.today.weeklyReview });
});

app.post('/v1/reviews/weekly', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ adjustment: z.string().trim().min(3).max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  const debrief = debriefFor(state);
  try {
    await saveWeeklyReview(c.env, user.accessToken, {
      weekStart: debrief.weekStart,
      summary: { executionScore: debrief.executionScore, foregroundFocus: debrief.foregroundFocus, friction: debrief.friction, trackSignals: debrief.trackSignals.map((signal) => signal.code) },
      ...(parsed.data.adjustment ? { adjustment: parsed.data.adjustment } : {}),
    });
  } catch (error) { return loopFailure(c, error); }
  return c.json({ debrief, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

const osChangeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('morning_sequence'), value: z.array(z.string().trim().min(1).max(240)).max(5) }),
  z.object({ field: z.enum(['hard_boundaries', 'non_negotiables', 'core_values']), value: z.array(z.string().trim().min(1).max(300)).max(20) }),
  z.object({ field: z.literal('coaching_firmness'), value: z.enum(['gentle', 'direct', 'high_pressure']) }),
  z.object({ field: z.literal('day_start'), value: z.enum(['guided', 'hard']) }),
  z.object({ field: z.literal('coaching_reminder_days'), value: z.number().int().min(1).max(60) }),
  z.object({ field: z.literal('show_seven_day_snapshot'), value: z.boolean() }),
  z.object({ field: z.enum(['review_day', 'recovery_day']), value: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) }),
  z.object({ field: z.literal('north_star'), value: z.string().trim().max(1000) }),
  z.object({ field: z.literal('pillar'), value: z.object({ name: pillarSchema, critical: z.boolean(), minimumFloor: z.string().trim().max(300).optional() }) }),
  z.object({ field: z.literal('tracks'), value: z.array(trackSchema).max(7) }),
  z.object({ field: z.literal('track_settings'), value: z.object({
    hardStop: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).optional(),
    homeTouchpoint: z.string().trim().min(5).max(200).optional(),
    movementFloor: z.string().trim().min(5).max(200).optional(),
    bufferMonths: z.number().min(0).max(120).optional(),
    bufferTarget: z.number().min(0).max(120).optional(),
    highInterestDebt: z.boolean().optional(),
    debtOrder: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  }).strict() }),
]);

// BHPC Chat C, the Drafting Room: draft a change, then apply it. Nothing is real until applied.
app.post('/v1/os/changes', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null) as { reason?: unknown } | null;
  const parsed = osChangeSchema.safeParse(body);
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
  if (!parsed.success) return c.json({ error: 'invalid_request', fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, 400);
  let draft;
  try { draft = await draftOsChange(c.env, user.accessToken, { field: parsed.data.field, value: parsed.data.value, reason }); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ change: draft, ...(await buildUserState(c.env, user.accessToken, user.id)) }, 201);
});

app.post('/v1/os/changes/:id/apply', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  let applied;
  // A pillar-floor change regenerates the affected plans on its effective date, when the
  // next read reconciles it (ensureGoalPlans → reconcilePillarRebuilds, 0037).
  try { applied = await applyOsChange(c.env, user.accessToken, c.req.param('id')); }
  catch (error) { return loopFailure(c, error); }
  return c.json({ change: applied, message: `Applied. It takes effect from ${applied.effective_from}: today's locked agenda is not rewritten.`, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/os/changes/:id/discard', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  try { await discardOsChange(c.env, user.accessToken, c.req.param('id')); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/body/clearance', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ confirm: z.literal(true) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'confirmation_required', message: 'Confirm that a clinician has cleared you to continue body goals.' }, 400);
  try {
    await recordClinicianClearance(c.env, user.accessToken);
    await rebuildBodyPlans(c.env, user.accessToken, user.id, 'clearance', new Date());
  } catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/goals', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({
    title: z.string().trim().min(3).max(300),
    outcome: z.string().trim().max(800).optional(),
    pillar: pillarSchema.optional(),
    targetDate: dateOnlySchema.optional(),
    confirmPivot: z.boolean().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, 400);
  const now = new Date();
  const graph = await getLifeGraph(c.env, user.accessToken, user.id);
  const activeTracks = new Set(graph.tracks.filter((track) => track.active).map((track) => track.key));
  // Strategic Patience: no new project before the foreground reaches its 30-day gate, unless declared.
  const foregroundPlan = planEntries(graph).find((entry) => entry.record.goalId === graph.personalOS?.foregroundGoalId && entry.record.status === 'active');
  const foregroundDay = foregroundPlan ? Math.floor((Date.parse(`${localToday(graph, now)}T00:00:00Z`) - Date.parse(`${foregroundPlan.plan.startDate}T00:00:00Z`)) / 86_400_000) + 1 : undefined;
  if (activeTracks.has('strategic_patience') && foregroundDay !== undefined && foregroundDay < 30 && !parsed.data.confirmPivot) {
    return c.json({ error: 'patience_gate', reasonCode: 'patience.premature_pivot', message: `Strategic Patience is active: your foreground is on day ${foregroundDay} of 30. Add this anyway only as a declared choice.` }, 409);
  }
  const { confirmPivot: _confirm, ...goalInput } = parsed.data;
  void _confirm;
  const plan = buildGoalPlan(graph, goalInput, now);
  let created;
  try { created = await createGoalWithPlan(c.env, user.id, goalInput, plan); }
  catch (error) { return loopFailure(c, error); }
  const state = await buildUserState(c.env, user.accessToken, user.id);
  // BHPC: a new project is run through the Arbitration Engine against the current foreground.
  // The result is a recommendation; only the user moves the foreground.
  const arbitration = selectForeground({
    plans: planEntries(state.graph),
    goals: state.graph.goals,
    date: localToday(state.graph, now),
    completions: state.graph.planCompletions,
    // Track rules shape arbitration, not only new-goal filters (Billionaire Mindset).
    trackKeys: [...activeTracks],
  });
  return c.json({
    goalId: created.goal.id,
    arbitration: arbitration.arbitration ?? null,
    recommendedForegroundGoalId: arbitration.foreground?.record.goalId ?? null,
    ...(activeTracks.has('billionaire_mindset') ? { filters: ['Long-horizon: is this still right in 10 years?', 'Asymmetry: what is the upside vs downside?', 'Downside containment: is the worst case survivable?', 'Leverage: does this scale without you?'] } : {}),
    ...state,
  }, 201);
});

app.post('/v1/goals/:id/foreground', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  try { await setForegroundGoal(c.env, user.accessToken, c.req.param('id')); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/goal-plans/:id/gate-review', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ gate: z.enum(['foundation', 'build']), stillAligned: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  try { await reviewGoalPlanGate(c.env, user.accessToken, { planId: c.req.param('id'), ...parsed.data }); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/goal-plans/:id/decision', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ decision: z.enum(['promote', 'maintain', 'park']), reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  try { await decideGoalPlan(c.env, user.accessToken, { planId: c.req.param('id'), ...parsed.data }); }
  catch (error) { return loopFailure(c, error); }
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/next-actions/:id/complete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  let result;
  try { result = await completeNextAction(c.env, user.accessToken, user.id, c.req.param('id')); }
  catch (error) { return loopFailure(c, asLoopError(error)); }
  if (!result) return c.json({ error: 'not_found' }, 404);
  await audit(c.env, user.accessToken, user.id, 'next_action.completed', {}, 'next_action', c.req.param('id'));
  return c.json({ ...result, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/apm/coach', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({
    message: z.string().trim().max(8000).optional(),
    choice: z.enum(COACH_CHOICES as [string, ...string[]]).optional(),
    sessionId: z.string().uuid().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await buildUserState(c.env, user.accessToken, user.id);
  const modeState: ModeState = state.mode;
  const { reply, turn } = await coach({
    env: c.env, accessToken: user.accessToken, userId: user.id, graph: state.graph, plan: state.plan, modeState,
    message: parsed.data.message, choice: parsed.data.choice as never, sessionId: parsed.data.sessionId,
  });
  let today: Awaited<ReturnType<typeof buildUserState>> | undefined;
  if (turn.modeRequest) {
    // Deep Work ended early / Executive Review closed: the same deterministic
    // transition rules apply, and the client gets the rebuilt Today with it.
    const changed = await changeMode(c.env, user.accessToken, user.id, turn.modeRequest);
    if (changed.ok) today = await buildUserState(c.env, user.accessToken, user.id);
  }
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'coaching_turn', { mode: reply.mode, phase: reply.phase, engine: reply.engine, step: reply.step });
  return c.json({ ...reply, modeState: today?.mode ?? state.mode, ...(today ? { today } : {}) });
});
app.post('/v1/apm/coach/:sessionId/close', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  await closeCoachingSession({ env: c.env, accessToken: user.accessToken, userId: user.id, sessionId: c.req.param('sessionId') });
  return c.json({ ok: true });
});

app.post('/v1/connections/oauth/start', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  // access 'act' is a separate, explicit consent for provider write scopes (Autopilot).
  const parsed = z.object({ provider: providerSchema, kind: integrationKindSchema, codeChallenge: z.string().min(20).max(200), redirectUri: z.string().url().optional(), access: z.enum(['read','act']).default('read') }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await createOAuthState(c.env, { userId: user.id, provider: parsed.data.provider, kind: parsed.data.kind, codeChallenge: parsed.data.codeChallenge });
  return c.json({ state, authorizationUrl: buildOAuthAuthorizationUrl({ env: c.env, ...parsed.data, state }) });
});

app.post('/v1/connections/oauth/exchange', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ provider: providerSchema, kind: integrationKindSchema, code: z.string().min(1), codeVerifier: z.string().min(20).max(200), state: z.string().min(20), redirectUri: z.string().url().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const state = await verifyOAuthState<{ exp: number; userId: string; provider: string; kind: string; codeChallenge: string }>(c.env, parsed.data.state);
  if (state.userId !== user.id || state.provider !== parsed.data.provider || state.kind !== parsed.data.kind) return c.json({ error: 'oauth_state_mismatch' }, 403);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parsed.data.codeVerifier)));
  let binary = ''; for (const byte of digest) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  if (challenge !== state.codeChallenge) return c.json({ error: 'oauth_pkce_mismatch' }, 403);
  const connection = await exchangeAndStoreOAuthConnection({ env: c.env, accessToken: user.accessToken, userId: user.id, provider: parsed.data.provider, kind: parsed.data.kind, code: parsed.data.code, codeVerifier: parsed.data.codeVerifier, redirectUri: parsed.data.redirectUri });
  await audit(c.env, user.accessToken, user.id, 'integration.connected', { provider: parsed.data.provider, kind: parsed.data.kind }, 'integration_connection', connection.connectionId);
  return c.json(connection);
});

app.post('/v1/calendar/device/sync', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ from: z.string().datetime(), to: z.string().datetime(), events: z.array(deviceCalendarEventSchema).max(5000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const result = await syncDeviceCalendar({ env: c.env, accessToken: user.accessToken, userId: user.id, ...parsed.data });
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'calendar_synced', { provider: 'device', count: result.count });
  return c.json({ ...result, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/calendar/connections/:id/sync', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const result = await syncCloudCalendar({ env: c.env, accessToken: user.accessToken, userId: user.id, connectionId: c.req.param('id') });
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'calendar_synced', { provider: result.provider, count: result.count });
  return c.json({ ...result, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/email/connections/:id/sync', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ maxMessages: z.number().int().min(1).max(50).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const result = await syncEmailSignals({ env: c.env, accessToken: user.accessToken, userId: user.id, connectionId: c.req.param('id'), maxMessages: parsed.data.maxMessages });
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'email_synced', { provider: result.provider, messagesProcessed: result.messagesProcessed, signalsStored: result.signalsStored });
  return c.json({ ...result, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.put('/v1/permissions/:domain/:actionType', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const domain = z.enum(['calendar','email','routine','life_graph','purchase','notification','connector','appointment','subscription']).safeParse(c.req.param('domain'));
  const parsed = z.object({ autonomyLevel: z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]), constraints: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!domain.success || !parsed.success) return c.json({ error: 'invalid_request' }, 400);

  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  const entitlement = graph.entitlement;
  const ceiling = entitlement && entitlementIsUsable(entitlement)
    ? maxAutonomyForPlan(entitlement.plan, domain.data as ActionDomain)
    : 0;

  const requestedLevel = parsed.data.enabled === false ? 0 : parsed.data.autonomyLevel;
  if (requestedLevel > ceiling) {
    return c.json({
      error: 'plan_autonomy_ceiling',
      currentPlan: entitlement?.plan === 'household' ? 'autopilot' : entitlement?.plan ?? 'beta',
      requestedLevel,
      maxAutonomyLevel: ceiling,
      maxAutonomyLabel: autonomyLabels[ceiling],
    }, 403);
  }

  const permission = await upsertPermission(c.env, user.accessToken, user.id, { domain: domain.data, actionType: c.req.param('actionType'), autonomyLevel: requestedLevel as AutonomyLevel, constraints: parsed.data.constraints, enabled: requestedLevel > 0 && parsed.data.enabled !== false });
  await audit(c.env, user.accessToken, user.id, 'permission.changed', { domain: permission.domain, actionType: permission.actionType, autonomyLevel: permission.autonomyLevel, plan: entitlement?.plan ?? 'beta' }, 'permission', permission.id);
  return c.json({ permission });
});

app.post('/v1/actions/prepare', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ domain: z.enum(['calendar','email','routine','life_graph','notification','connector']), actionType: z.string().min(3).max(120), payload: z.record(z.string(), z.unknown()), reason: z.string().min(3).max(1000), idempotencyKey: z.string().min(8).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  const permission = graph.permissions.find((p) => p.domain === parsed.data.domain && p.actionType === parsed.data.actionType && p.enabled);
  const action = await prepareAction({ env: c.env, accessToken: user.accessToken, userId: user.id, ...parsed.data, permission, entitlement: graph.entitlement });
  await audit(c.env, user.accessToken, user.id, 'action.prepared', { domain: action.domain, actionType: action.actionType }, 'action', action.id);
  return c.json({ action }, 201);
});

app.post('/v1/actions/:id/approve', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  const action = graph.actions.find((candidate) => candidate.id === c.req.param('id'));
  if (!action) return c.json({ error: 'not_found' }, 404);
  if (action.status !== 'prepared' && action.status !== 'approved') return c.json({ error: 'invalid_action_state' }, 409);
  // An Autopilot stop (payment asked / no emailed route) is the user's to finish; approval never executes it.
  if (action.payload && typeof action.payload === 'object' && 'stoppedReason' in action.payload) return c.json({ error: 'needs_user' }, 409);
  const permission = graph.permissions.find((p) => p.domain === action.domain && p.actionType === action.actionType && p.enabled);
  const executed = await approveAndMaybeExecuteAction({ env: c.env, accessToken: user.accessToken, userId: user.id, action: action as ActionRecord, permission, entitlement: graph.entitlement });
  await audit(c.env, user.accessToken, user.id, 'action.executed', { domain: executed.domain, actionType: executed.actionType, status: executed.status }, 'action', executed.id);
  return c.json({ action: executed });
});

async function autopilotContext(env: ApiEnv, accessToken: string, userId: string) {
  const graph = await getLifeGraph(env, accessToken, userId);
  const entitled = hasAutopilotAccess(graph.entitlement);
  const state = await getAutopilotState(env, accessToken, userId, entitled);
  return { graph, entitled, state };
}

function autopilotResponse(state: Awaited<ReturnType<typeof getAutopilotState>>, graph: Awaited<ReturnType<typeof getLifeGraph>>) {
  return {
    autopilot: state,
    permissions: Object.values(standingActionClasses).map((policy) => {
      const permission = graph.permissions.find((p) => p.domain === policy.domain && p.actionType === policy.actionType);
      return { actionClass: policy.actionClass, domain: policy.domain, autonomyLevel: permission?.enabled ? permission.autonomyLevel : 0 };
    }),
    supported: Object.values(standingActionClasses),
    neverStanding: forbiddenStandingActions,
  };
}

function autopilotFailure(c: any, error: unknown) {
  const mapped = autopilotErrorResponse(error);
  if (!mapped) throw error;
  return c.json(mapped.reason ? { error: mapped.error, reason: mapped.reason } : { error: mapped.error }, mapped.status);
}

app.get('/v1/autopilot', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { graph, state } = await autopilotContext(c.env, user.accessToken, user.id);
  return c.json(autopilotResponse(state, graph));
});

app.post('/v1/autopilot/rules', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = autopilotGrantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const problems = validateStandingConstraints(parsed.data.actionClass, parsed.data.constraints as Record<string, unknown>);
  if (problems.length) return c.json({ error: 'invalid_constraints', problems }, 400);
  const graph = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasAutopilotAccess(graph.entitlement)) return c.json({ error: 'autopilot_required' }, 403);
  try {
    const rule = await grantAutopilotRule(c.env, user.accessToken, parsed.data);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'autopilot_rule_granted', { actionClass: rule.actionClass });
    return c.json({ rule }, 201);
  } catch (error) { return autopilotFailure(c, error); }
});

app.patch('/v1/autopilot/rules/:id', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = autopilotUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { entitled, state } = await autopilotContext(c.env, user.accessToken, user.id);
  if (!entitled) return c.json({ error: 'autopilot_required' }, 403);
  const rule = state.rules.find((candidate) => candidate.id === c.req.param('id'));
  if (!rule) return c.json({ error: 'not_found' }, 404);
  if (parsed.data.constraints) {
    const problems = validateStandingConstraints(rule.actionClass, parsed.data.constraints);
    if (problems.length) return c.json({ error: 'invalid_constraints', problems }, 400);
  }
  try {
    return c.json({ rule: await updateAutopilotRule(c.env, user.accessToken, rule.id, parsed.data as { expectedVersion: number; constraints?: any; expiresAt?: string }) });
  } catch (error) { return autopilotFailure(c, error); }
});

for (const [path, status] of [['pause', 'paused'], ['resume', 'active']] as const) {
  app.post(`/v1/autopilot/rules/:id/${path}`, async (c) => {
    const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
    const parsed = autopilotVersionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    // Pausing is owner-only in the database and never needs the entitlement.
    try {
      return c.json({ rule: await setAutopilotRuleStatus(c.env, user.accessToken, c.req.param('id'), status, parsed.data.expectedVersion) });
    } catch (error) { return autopilotFailure(c, error); }
  });
}

app.post('/v1/autopilot/rules/:id/revoke', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  try {
    return c.json({ rule: await revokeAutopilotRule(c.env, user.accessToken, c.req.param('id'), parsed.data.reason) });
  } catch (error) { return autopilotFailure(c, error); }
});

app.put('/v1/autopilot/pause', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ paused: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  try {
    return c.json(await setAutopilotMasterPause(c.env, user.accessToken, parsed.data.paused));
  } catch (error) { return autopilotFailure(c, error); }
});

app.post('/v1/autopilot/rules/:id/run', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const base = z.object({ ...autopilotRunBaseSchema, payload: z.record(z.string(), z.unknown()) }).safeParse(body);
  if (!base.success) return c.json({ error: 'invalid_request' }, 400);
  const { graph, entitled, state } = await autopilotContext(c.env, user.accessToken, user.id);
  if (!entitled) return c.json({ error: 'autopilot_required' }, 403);
  const rule = state.rules.find((candidate) => candidate.id === c.req.param('id'));
  if (!rule) return c.json({ error: 'not_found' }, 404);
  const payload = autopilotRunPayloadSchemas[rule.actionClass].safeParse(base.data.payload);
  if (!payload.success) return c.json({ error: 'invalid_request' }, 400);
  const policy = standingActionClasses[rule.actionClass];
  const permission = graph.permissions.find((p) => p.domain === policy.domain && p.actionType === policy.actionType && p.enabled);
  try {
    const result = await runStandingRule({
      env: c.env, accessToken: user.accessToken, userId: user.id, rule, state, permission, entitlement: graph.entitlement,
      idempotencyKey: base.data.idempotencyKey, reason: base.data.reason, payload: payload.data,
    });
    if (!result.replayed) {
      await recordAnalyticsEvent(c.env, user.accessToken, user.id, result.stopped ? 'autopilot_stopped' : 'autopilot_executed', { actionClass: rule.actionClass });
    }
    return c.json(result, result.replayed ? 200 : result.stopped ? 202 : 201);
  } catch (error) { return autopilotFailure(c, error); }
});

app.post('/v1/autopilot/executions/:id/undo', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  try {
    const execution = await undoStandingExecution({ env: c.env, accessToken: user.accessToken, userId: user.id, executionId: c.req.param('id') });
    return c.json({ execution });
  } catch (error) { return autopilotFailure(c, error); }
});

// The daily done-list: what Autopilot did today (user's local day unless ?day=),
// each with Undo or a clear "can't undo". Owner-only, so it survives downgrade.
app.get('/v1/autopilot/done', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const requested = c.req.query('day');
  if (requested !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return c.json({ error: 'invalid_request' }, 400);
  const graph = requested ? undefined : await getLifeGraph(c.env, user.accessToken, user.id);
  const day = requested ?? localMoment(new Date(), graph?.identity.timezone || 'UTC').date;
  try {
    return c.json({ day, items: await getAutopilotDoneList(c.env, user.accessToken, day) });
  } catch (error) { return autopilotFailure(c, error); }
});

app.put('/v1/autopilot/flexible-events/:eventId', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ flexible: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  const eventId = z.string().uuid().safeParse(c.req.param('eventId'));
  if (!parsed.success || !eventId.success) return c.json({ error: 'invalid_request' }, 400);
  try {
    return c.json(await setAutopilotEventFlexible(c.env, user.accessToken, eventId.data, parsed.data.flexible));
  } catch (error) { return autopilotFailure(c, error); }
});

app.get('/v1/privacy/autopilot', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await getAutopilotExportState(c.env, user.accessToken));
});

app.post('/v1/push/register', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ expoPushToken: z.string().min(10).max(500), deviceId: z.string().max(300).optional(), platform: z.enum(['ios','android','web']).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  await registerPushSubscription(c.env, user.accessToken, user.id, parsed.data);
  return c.json({ ok: true });
});

app.post('/v1/push/evaluate', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { graph, mode } = await buildUserState(c.env, user.accessToken, user.id);
  const hold = workPushHold(graph, mode, new Date());
  return c.json(await notifyRadarItems({ env: c.env, accessToken: user.accessToken, userId: user.id, radarItems: graph.radarItems, timezone: graph.identity.timezone, ...(hold ? { hold } : {}) }));
});

const hhmmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
app.get('/v1/notifications/preferences', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await supabaseRest<Array<Record<string, unknown>>>(c.env, user.accessToken, `/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(user.id)}&select=enabled,quiet_hours,lock_screen_detail,minimum_severity,morning_push_enabled,wake_time&limit=1`);
  return c.json({ preferences: rows[0] ?? null });
});
app.put('/v1/notifications/preferences', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({
    enabled: z.boolean().optional(),
    morningPushEnabled: z.boolean().optional(),
    wakeTime: hhmmSchema.optional(),
    lockScreenDetail: z.enum(['minimal', 'normal']).optional(),
    quietHours: z.union([z.object({ start: hhmmSchema, end: hhmmSchema }), z.object({})]).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const patch: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
  if (parsed.data.morningPushEnabled !== undefined) patch.morning_push_enabled = parsed.data.morningPushEnabled;
  if (parsed.data.wakeTime) patch.wake_time = parsed.data.wakeTime;
  if (parsed.data.lockScreenDetail) patch.lock_screen_detail = parsed.data.lockScreenDetail;
  if (parsed.data.quietHours) patch.quiet_hours = parsed.data.quietHours;
  const rows = await supabaseRest<Array<Record<string, unknown>>>(c.env, user.accessToken, '/rest/v1/notification_preferences?on_conflict=user_id&select=enabled,quiet_hours,lock_screen_detail,minimum_severity,morning_push_enabled,wake_time', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([patch]),
  });
  await audit(c.env, user.accessToken, user.id, 'notification_preferences.updated', { fields: Object.keys(patch).filter((key) => key !== 'user_id' && key !== 'updated_at') }, 'notification_preferences', user.id);
  return c.json({ preferences: rows[0] ?? null });
});

app.get('/v1/trust/model-routes', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ routes: await listModelRoutes(c.env, user.accessToken) });
});
app.get('/v1/trust/activity', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ events: await getAuditEvents(c.env, user.accessToken, user.id, Number(c.req.query('limit') ?? 100)) });
});

app.get('/v1/privacy/life-os', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await getLifeOsExportState(c.env, user.accessToken, user.id));
});

app.post('/v1/privacy/export', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const job = await requestDataRightsJob(c.env, user.accessToken, user.id, 'export');
  const state = await buildUserState(c.env, user.accessToken, user.id);
  const retainedLifeOs = await getLifeOsExportState(c.env, user.accessToken, user.id);
  const lifeGraph = {
    ...state.graph,
    lifeRelationships: retainedLifeOs.lifeRelationships,
    lifeAdminItems: retainedLifeOs.lifeAdminItems,
  };
  const autopilot = await getAutopilotExportState(c.env, user.accessToken);
  const dailyLoop = await getDailyLoopExportState(c.env, user.accessToken);
  const activity = await getAuditEvents(c.env, user.accessToken, user.id, 250);
  await supabaseRest(c.env, user.accessToken, `/rest/v1/data_rights_jobs?id=eq.${encodeURIComponent(job.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'complete', completed_at: new Date().toISOString() }) });
  return c.json({ job: { ...job, status: 'complete' }, export: { generatedAt: new Date().toISOString(), lifeGraph, autopilot, dailyLoop, activity } });
});
app.post('/v1/privacy/delete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ confirmation: z.literal('DELETE') }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'confirmation_required' }, 400);
  const job = await requestDataRightsJob(c.env, user.accessToken, user.id, 'delete');
  await audit(c.env, user.accessToken, user.id, 'deletion.requested', {}, 'data_rights_job', job.id);
  return c.json({ job, status: 'requested', note: 'Account deletion requires the privileged deletion worker to revoke sessions/connectors and remove the auth identity. It is not falsely marked complete here.' }, 202);
});

app.get('/v1/households', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ error: 'household_waitlist_only', message: 'Household OS is not active yet. Use the Household interest list instead.' }, 409);
});
app.post('/v1/households', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ error: 'household_waitlist_only', message: 'Household OS is not active yet. Joining the interest list does not grant Household access.' }, 409);
});
app.post('/v1/households/:id/items', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ error: 'household_waitlist_only', message: 'Household OS is not active yet.' }, 409);
});

app.post('/v1/analytics/event', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ eventName: z.enum(['daily_plan_viewed','radar_item_viewed','radar_item_acted','radar_item_corrected','radar_item_dismissed','privacy_center_viewed','provider_transparency_viewed','notification_opened','integration_disconnected','household_interest_changed','product_plan_viewed','life_os_relationship_saved','life_os_item_created','life_os_item_completed']), properties: z.record(z.string(), z.union([z.string(),z.number(),z.boolean(),z.null()])).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, parsed.data.eventName, parsed.data.properties ?? {});
  return c.json({ ok: true });
});

app.onError((error, c) => {
  const requestId = c.res.headers.get('x-request-id') ?? 'unknown';
  console.error('APM API error', { requestId, name: error.name, message: error.message });
  return c.json({ error: 'internal_error', requestId }, 500);
});

export default app;
