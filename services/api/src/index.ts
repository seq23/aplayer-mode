import { Hono } from 'hono';
import { z } from 'zod';
import { buildDailyPlan } from '@apm/planning';
import { buildRadarItems } from '@apm/radar';
import { authenticateRequest } from './auth';
import type { ApiEnv } from './env';
import { completeNextAction, getLifeGraph, saveOnboarding } from './lifeGraphRepository';

type WorkerEnv = { Bindings: ApiEnv };

const app = new Hono<WorkerEnv>();

const onboardingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  primaryGoal: z.string().trim().min(5).max(500),
  currentSeason: z.string().trim().max(240).optional(),
  becoming: z.string().trim().max(500).optional(),
  pillar: z.enum(['wealth', 'body', 'spirit', 'execution']).optional(),
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
