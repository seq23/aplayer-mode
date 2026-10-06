import { Hono } from 'hono';
import { z } from 'zod';
import { buildDailyPlan } from '@apm/planning';
import { buildRadarItems } from '@apm/radar';
import { authenticateRequest } from './auth';
import type { ApiEnv } from './env';
import {
  completeNextAction,
  getLifeGraph,
  saveMethodologyIntake,
  saveOnboarding,
  setOperatingMode,
} from './lifeGraphRepository';

type WorkerEnv = { Bindings: ApiEnv };

const app = new Hono<WorkerEnv>();

const pillarSchema = z.enum(['wealth', 'body', 'spirit', 'execution']);
const trackSchema = z.enum([
  'billionaire_mindset',
  'operator_discipline',
  'strategic_patience',
  'manifestation_mastery',
  'investor_ai_leverage',
]);
const modeSchema = z.enum(['standard', 'recovery', 'high_pressure', 'executive_review']);

const onboardingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  primaryGoal: z.string().trim().min(5).max(500),
  currentSeason: z.string().trim().max(240).optional(),
  becoming: z.string().trim().max(500).optional(),
  pillar: pillarSchema.optional(),
});

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
    firmness: z.enum(['gentle', 'direct', 'high_pressure']),
    helpfulLanguage: z.string().trim().max(500).optional(),
    avoidLanguage: z.string().trim().max(500).optional(),
  }),
  accountability: z.object({
    dayStart: z.enum(['guided', 'hard']),
    coachingReminderAfterDays: z.number().int().min(1).max(60).optional(),
  }),
  criticalPillars: z.array(pillarSchema).max(4),
  minimumFloors: z.object({
    wealth: z.string().trim().max(300).optional(),
    body: z.string().trim().max(300).optional(),
    spirit: z.string().trim().max(300).optional(),
    execution: z.string().trim().max(300).optional(),
  }),
  trackKeys: z.array(trackSchema).max(5),
  activeMode: modeSchema.optional(),
});

async function buildUserState(env: ApiEnv, accessToken: string, userId: string) {
  const persistedGraph = await getLifeGraph(env, accessToken, userId);
  const graph = {
    ...persistedGraph,
    radarItems: buildRadarItems(persistedGraph),
  };
  const plan = buildDailyPlan(graph);
  return { graph, plan };
}

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.header('x-request-id', requestId);
  c.header('cache-control', 'no-store');

  if (c.env.ALLOWED_ORIGIN) {
    c.header('access-control-allow-origin', c.env.ALLOWED_ORIGIN);
    c.header('access-control-allow-headers', 'authorization, content-type, x-request-id');
    c.header('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

app.get('/v1/health', (c) =>
  c.json({
    ok: true,
    service: 'aplayer-mode-api',
    dataPlatform: 'supabase',
    time: new Date().toISOString(),
  }),
);

app.get('/v1/me/life-graph', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const { graph } = await buildUserState(c.env, user.accessToken, user.id);
  return c.json({ graph });
});

app.get('/v1/me/today', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  return c.json(await buildUserState(c.env, user.accessToken, user.id));
});

app.put('/v1/onboarding', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const rawBody = await c.req.json().catch(() => null);
  const parsed = onboardingSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      400,
    );
  }

  await saveOnboarding(c.env, user.accessToken, user.id, parsed.data);
  return c.json(await buildUserState(c.env, user.accessToken, user.id), 200);
});

app.put('/v1/methodology/intake', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const rawBody = await c.req.json().catch(() => null);
  const parsed = methodologyIntakeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      400,
    );
  }

  await saveMethodologyIntake(c.env, user.accessToken, user.id, parsed.data);
  return c.json(await buildUserState(c.env, user.accessToken, user.id), 200);
});

app.post('/v1/methodology/mode', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const rawBody = await c.req.json().catch(() => null);
  const parsed = z.object({ mode: modeSchema }).safeParse(rawBody);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

  await setOperatingMode(c.env, user.accessToken, user.id, parsed.data.mode);
  return c.json(await buildUserState(c.env, user.accessToken, user.id), 200);
});

app.post('/v1/next-actions/:id/complete', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const result = await completeNextAction(c.env, user.accessToken, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'not_found' }, 404);

  const state = await buildUserState(c.env, user.accessToken, user.id);
  return c.json({ ...result, ...state });
});

app.onError((error, c) => {
  const requestId = c.res.headers.get('x-request-id') ?? 'unknown';
  console.error('APM API error', { requestId, name: error.name, message: error.message });
  return c.json({ error: 'internal_error', requestId }, 500);
});

export default app;
