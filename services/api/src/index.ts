import { Hono } from 'hono';
import { z } from 'zod';
import { buildDailyPlan } from '@apm/planning';
import { buildRadarItems } from '@apm/radar';
import type { ActionRecord, AutonomyLevel, OperatingModeKey, SubscriptionEntitlement } from '@apm/domain';
import { autonomyLabels, capabilitiesForPlan, maxAutonomyForPlan, planHasCapability, productPlanPolicies, type ActionDomain, type ProductPlan } from '@apm/policy';
import { authenticateRequest } from './auth';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';
import {
  completeNextAction,
  getLifeGraph,
  saveMethodologyIntake,
  saveOnboarding,
  setOperatingMode,
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
import { approveAndMaybeExecuteAction, prepareAction } from './actionEngine';
import { notifyRadarItems } from './push';

type WorkerEnv = { Bindings: ApiEnv };
const app = new Hono<WorkerEnv>();

const pillarSchema = z.enum(['wealth', 'body', 'spirit', 'execution']);
const trackSchema = z.enum(['billionaire_mindset','operator_discipline','strategic_patience','manifestation_mastery','investor_ai_leverage','resilience']);
const modeSchema = z.enum(['standard','recovery','high_pressure','executive_review','sprint','deep_work']);
const providerSchema = z.enum(['google','microsoft']);
const integrationKindSchema = z.enum(['calendar','email']);

const onboardingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  primaryGoal: z.string().trim().min(5).max(500),
  currentSeason: z.string().trim().max(240).optional(),
  becoming: z.string().trim().max(500).optional(),
  pillar: pillarSchema.optional(),
});


const planPriceLabels: Record<ProductPlan, string> = {
  beta: 'Free during beta',
  chief_of_staff: '$29/mo standard · $24/mo founding hypothesis',
  life_os: '~$59/mo',
  autopilot: '~$129+/mo',
  household: 'Waitlist only',
};

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
  goalTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  trackKeys: z.array(trackSchema).max(6),
  activeMode: modeSchema.optional(),
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
const lifeAdminRecurrenceSchema = z.object({
  frequency: z.enum(['daily','weekly','monthly','yearly']).optional(),
  interval: z.number().int().min(1).max(365).optional(),
}).default({});
const optionalDateSchema = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional();
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
  cadenceDays: z.number().int().min(1).max(3650).optional(),
  notes: z.string().max(4000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const lifeAdminCreateSchema = z.object({
  personId: z.string().uuid().optional(),
  kind: lifeAdminKindSchema,
  title: z.string().trim().min(1).max(500),
  status: lifeAdminStatusSchema.optional(),
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
  status: lifeAdminStatusSchema.optional(),
  importance: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]).optional(),
  dueAt: optionalDateTimeSchema,
  startsAt: optionalDateTimeSchema,
  endsAt: optionalDateTimeSchema,
  recurrence: lifeAdminRecurrenceSchema.optional(),
  amountMinor: z.number().int().min(0).max(9_000_000_000_000).optional(),
  currency: z.union([z.string().regex(/^[A-Z]{3}$/), z.literal('')]).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const deviceCalendarEventSchema = z.object({
  provider: z.string().default('device'), externalEventId: z.string().min(1).max(500), calendarExternalId: z.string().max(500).optional(),
  title: z.string().max(1000).default(''), location: z.string().max(1000).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(),
  timezone: z.string().max(120).optional(), allDay: z.boolean(), availability: z.enum(['free','busy','tentative','out_of_office']).default('busy'),
  recurrence: z.record(z.string(), z.unknown()).optional(), organizer: z.record(z.string(), z.unknown()).optional(), attendees: z.array(z.unknown()).optional(),
  sourceVersion: z.string().max(500).optional(), deleted: z.boolean().optional(),
});

async function buildUserState(env: ApiEnv, accessToken: string, userId: string) {
  const persistedGraph = await getLifeGraph(env, accessToken, userId);
  const graph = { ...persistedGraph, radarItems: buildRadarItems(persistedGraph) };
  return { graph, plan: buildDailyPlan(graph) };
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
    await audit(c.env, user.accessToken, user.id, 'life_os.relationship_saved', { personId: created.personId }, 'life_relationship', created.relationship.id);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_relationship_saved');
    return c.json(await buildUserState(c.env, user.accessToken, user.id), 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'life_os_person_not_found') return c.json({ error: 'person_not_found' }, 404);
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
    await audit(c.env, user.accessToken, user.id, 'life_os.relationship_updated', {}, 'life_relationship', relationship.id);
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    if (error instanceof Error && error.message === 'life_os_relationship_not_found') return c.json({ error: 'not_found' }, 404);
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
    const item = await createLifeAdminItem(c.env, user.accessToken, user.id, parsed.data);
    await audit(c.env, user.accessToken, user.id, 'life_os.item_created', { kind: item.kind }, 'life_admin_item', item.id);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_item_created', { kind: item.kind });
    return c.json(await buildUserState(c.env, user.accessToken, user.id), 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'life_os_person_not_found') return c.json({ error: 'person_not_found' }, 404);
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
    const item = await updateLifeAdminItem(c.env, user.accessToken, user.id, c.req.param('id'), parsed.data);
    await audit(c.env, user.accessToken, user.id, 'life_os.item_updated', { kind: item.kind, status: item.status }, 'life_admin_item', item.id);
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    if (error instanceof Error && error.message === 'life_os_item_not_found') return c.json({ error: 'not_found' }, 404);
    if (error instanceof Error && error.message === 'life_os_person_not_found') return c.json({ error: 'person_not_found' }, 404);
    throw error;
  }
});

app.post('/v1/life-os/items/:id/complete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const before = await getLifeGraph(c.env, user.accessToken, user.id);
  if (!hasLifeOsAccess(before.entitlement)) return c.json({ error: 'life_os_required' }, 403);
  try {
    const item = await completeLifeAdminItem(c.env, user.accessToken, user.id, c.req.param('id'));
    await audit(c.env, user.accessToken, user.id, 'life_os.item_completed', { kind: item.kind, recurring: Boolean(item.recurrence.frequency), nextDueAt: item.status === 'open' ? item.dueAt ?? null : null }, 'life_admin_item', item.id);
    await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'life_os_item_completed', { kind: item.kind, recurring: Boolean(item.recurrence.frequency) });
    return c.json(await buildUserState(c.env, user.accessToken, user.id));
  } catch (error) {
    if (error instanceof Error && error.message === 'life_os_item_not_found') return c.json({ error: 'not_found' }, 404);
    if (error instanceof Error && error.message === 'life_os_item_cancelled') return c.json({ error: 'invalid_item_state' }, 409);
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
  await saveMethodologyIntake(c.env, user.accessToken, user.id, parsed.data);
  await audit(c.env, user.accessToken, user.id, 'personal_os.installed', { roles: parsed.data.roles.length, trackCount: parsed.data.trackKeys.length }, 'personal_os', user.id);
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/methodology/mode', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ mode: modeSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  await setOperatingMode(c.env, user.accessToken, user.id, parsed.data.mode);
  await audit(c.env, user.accessToken, user.id, 'operating_mode.changed', { mode: parsed.data.mode }, 'personal_os', user.id);
  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.post('/v1/methodology/day/close', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ verdict: z.enum(['full_day','mvd','miss']), note: z.string().trim().max(1000).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const row = await closeDay(c.env, user.accessToken, parsed.data.verdict, parsed.data.note);
  await audit(c.env, user.accessToken, user.id, 'day.closed', { verdict: parsed.data.verdict }, 'day_record', row.id);
  return c.json({ day: row, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/next-actions/:id/complete', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const result = await completeNextAction(c.env, user.accessToken, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'not_found' }, 404);
  await audit(c.env, user.accessToken, user.id, 'next_action.completed', {}, 'next_action', c.req.param('id'));
  return c.json({ ...result, ...(await buildUserState(c.env, user.accessToken, user.id)) });
});

app.post('/v1/apm/coach', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ message: z.string().trim().min(1).max(8000), sessionId: z.string().uuid().optional(), mode: modeSchema.optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  const result = await coach({ env: c.env, accessToken: user.accessToken, userId: user.id, graph, message: parsed.data.message, sessionId: parsed.data.sessionId, requestedMode: parsed.data.mode });
  await recordAnalyticsEvent(c.env, user.accessToken, user.id, 'coaching_turn', { mode: result.mode, closureReady: result.closureReady });
  return c.json(result);
});
app.post('/v1/apm/coach/:sessionId/close', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  await closeCoachingSession({ env: c.env, accessToken: user.accessToken, userId: user.id, sessionId: c.req.param('sessionId') });
  return c.json({ ok: true });
});

app.post('/v1/connections/oauth/start', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = z.object({ provider: providerSchema, kind: integrationKindSchema, codeChallenge: z.string().min(20).max(200), redirectUri: z.string().url().optional() }).safeParse(await c.req.json().catch(() => null));
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
  const domain = z.enum(['calendar','email','routine','life_graph','purchase','notification','connector']).safeParse(c.req.param('domain'));
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
  const permission = graph.permissions.find((p) => p.domain === action.domain && p.actionType === action.actionType && p.enabled);
  const executed = await approveAndMaybeExecuteAction({ env: c.env, accessToken: user.accessToken, userId: user.id, action: action as ActionRecord, permission, entitlement: graph.entitlement });
  await audit(c.env, user.accessToken, user.id, 'action.executed', { domain: executed.domain, actionType: executed.actionType, status: executed.status }, 'action', executed.id);
  return c.json({ action: executed });
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
  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  return c.json(await notifyRadarItems({ env: c.env, accessToken: user.accessToken, userId: user.id, radarItems: graph.radarItems }));
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
  const activity = await getAuditEvents(c.env, user.accessToken, user.id, 250);
  await supabaseRest(c.env, user.accessToken, `/rest/v1/data_rights_jobs?id=eq.${encodeURIComponent(job.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'complete', completed_at: new Date().toISOString() }) });
  return c.json({ job: { ...job, status: 'complete' }, export: { generatedAt: new Date().toISOString(), lifeGraph, activity } });
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
