import { Hono } from 'hono';
import { z } from 'zod';
import { authenticateRequest } from './auth';
import { withDb } from './db';
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

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.header('x-request-id', requestId);
  c.header('cache-control', 'no-store');
  await next();
});

app.get('/v1/health', (c) =>
  c.json({
    ok: true,
    service: 'aplayer-mode-api',
    time: new Date().toISOString(),
  }),
);

app.get('/v1/me/life-graph', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const graph = await withDb(c.env, (client) => getLifeGraph(client, user.id));
  return c.json({ graph });
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

  const graph = await withDb(c.env, (client) => saveOnboarding(client, user.id, parsed.data));
  return c.json({ graph }, 200);
});

app.post('/v1/next-actions/:id/complete', async (c) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const result = await withDb(c.env, (client) => completeNextAction(client, user.id, c.req.param('id')));
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

app.onError((error, c) => {
  const requestId = c.res.headers.get('x-request-id') ?? 'unknown';
  console.error('APM API error', { requestId, name: error.name, message: error.message });
  return c.json({ error: 'internal_error', requestId }, 500);
});

export default app;
