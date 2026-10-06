import type { LifeGraphSnapshot, OperatingModeKey } from '@apm/domain';
import type { ApiEnv } from './env';
import { supabaseRest } from './db';
import { runUserInference } from './aiGateway';
import { buildDailyPlan, coachingOpeningQuestion } from '@apm/planning';

interface CoachingTurnRow { id: string; role: 'user' | 'assistant'; content: string; created_at: string }
interface CoachingSessionRow { id: string; mode: OperatingModeKey; status: 'open' | 'closed'; turn_count: number; started_at: string }

export interface CoachReply {
  sessionId: string;
  mode: OperatingModeKey;
  reply: string;
  closureReady: boolean;
  nextAction?: string;
}

const coachSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    closureReady: { type: 'boolean' },
    nextAction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['reply','closureReady','nextAction'],
  additionalProperties: false,
};

function modeInstruction(mode: OperatingModeKey): string {
  switch (mode) {
    case 'high_pressure':
      return 'Use direct, unsentimental high-performance coaching. Treat the stated problem as a possible symptom. Challenge weak assumptions without shame or coercion. Ask at most one precision question. End with one stabilizing directive when enough signal exists.';
    case 'executive_review':
      return 'This is Executive Review. Introduce no new strategy. Organize only what the user already knows from supplied context. Open exactly with “Here’s what you already know that still makes you better:” and close exactly with “None of this is new — you’re just being reminded.” Do not ask questions.';
    case 'recovery':
      return 'Use Recovery Mode: supportive, low-pressure, no performance evaluation, no catch-up, and reduce scope to the smallest meaningful action that preserves continuity.';
    case 'sprint':
      return 'Use Sprint Mode: one foreground output, no new projects, brief action-oriented coaching, and protect the declared sprint boundary.';
    case 'deep_work':
      return 'Use Deep Work Mode: do not create conversational sprawl. Clarify the single focus task and direct the user into the uninterrupted block.';
    default:
      return 'Use standard APM coaching: briefly acknowledge, isolate the behavioral friction, ask exactly one useful question per turn, and close back into execution when enough signal exists.';
  }
}

function minimizedContext(graph: LifeGraphSnapshot) {
  const plan = buildDailyPlan(graph);
  return {
    identity: {
      currentSeason: graph.identity.currentSeason,
      becoming: graph.identity.becoming,
      roles: graph.roles.filter((role) => role.active).map((role) => role.name),
    },
    personalOS: graph.personalOS ? {
      northStar: graph.personalOS.northStar,
      values: graph.personalOS.values,
      nonNegotiables: graph.personalOS.nonNegotiables,
      failurePatterns: graph.personalOS.failurePatterns,
      coachingStyle: graph.personalOS.coachingStyle,
      hardBoundaries: graph.personalOS.hardBoundaries,
      activeMode: graph.personalOS.activeMode,
    } : undefined,
    foreground: graph.projects.find((project) => project.foreground && project.status === 'active')?.title,
    activeGoals: graph.goals.filter((goal) => goal.status === 'active').slice(0, 5).map((goal) => ({ title: goal.title, health: goal.health, targetDate: goal.targetDate })),
    activeTracks: graph.tracks.filter((track) => track.active).map((track) => track.name),
    today: { mode: plan.mode, numberOneMove: plan.numberOneMove?.title, morningSequence: plan.morningSequence },
  };
}

async function getOrCreateSession(input: { env: ApiEnv; accessToken: string; userId: string; sessionId?: string; mode: OperatingModeKey }): Promise<CoachingSessionRow> {
  if (input.sessionId) {
    const rows = await supabaseRest<CoachingSessionRow[]>(input.env, input.accessToken, `/rest/v1/coaching_sessions?id=eq.${encodeURIComponent(input.sessionId)}&user_id=eq.${encodeURIComponent(input.userId)}&status=eq.open&select=*&limit=1`);
    if (rows[0]) return rows[0];
  }
  const rows = await supabaseRest<CoachingSessionRow[]>(input.env, input.accessToken, '/rest/v1/coaching_sessions?select=*', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id: input.userId, mode: input.mode, status: 'open', turn_count: 0 }]),
  });
  if (!rows[0]) throw new Error('coaching_session_create_failed');
  return rows[0];
}

async function recentTurns(env: ApiEnv, accessToken: string, userId: string, sessionId: string): Promise<CoachingTurnRow[]> {
  return supabaseRest<CoachingTurnRow[]>(env, accessToken, `/rest/v1/coaching_turns?user_id=eq.${encodeURIComponent(userId)}&session_id=eq.${encodeURIComponent(sessionId)}&select=id,role,content,created_at&order=created_at.asc&limit=12`);
}

export async function coach(input: {
  env: ApiEnv;
  accessToken: string;
  userId: string;
  graph: LifeGraphSnapshot;
  message: string;
  sessionId?: string;
  requestedMode?: OperatingModeKey;
}): Promise<CoachReply> {
  const mode = input.requestedMode ?? input.graph.personalOS?.activeMode ?? 'standard';
  const session = await getOrCreateSession({ ...input, mode });
  await supabaseRest(input.env, input.accessToken, '/rest/v1/coaching_turns', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ user_id: input.userId, session_id: session.id, role: 'user', content: input.message.slice(0, 8000) }]),
  });
  const history = await recentTurns(input.env, input.accessToken, input.userId, session.id);

  const result = await runUserInference<{ reply: string; closureReady: boolean; nextAction: string | null }>({
    env: input.env,
    accessToken: input.accessToken,
    userId: input.userId,
    task: {
      taskType: `coaching_${mode}`,
      dataClass: 'private_life',
      requiredCapabilities: ['conversation','reasoning','structured_output'],
      minimumQualityScore: 75,
      system: [
        'You are the A Player Mode coaching runtime. Your job is not motivation; hold structure so the human can relax.',
        'Coaching is behavioral and decision-focused, not therapy, diagnosis, medical, legal, or financial advice.',
        'The user remains sovereign. Never shame, coerce, manipulate, or override consent.',
        'Do not invent facts. The Life Graph context is authoritative where supplied.',
        'Use one question at a time except Executive Review, which asks none.',
        modeInstruction(mode),
      ].join(' '),
      instruction: `Respond to the latest user turn. ${session.turn_count < 2 && mode === 'standard' ? 'Do not rush closure; gather enough signal first.' : ''} If closureReady is true, nextAction must be one physical, executable action. If not closureReady, nextAction should be null.`,
      context: {
        life: minimizedContext(input.graph),
        openingIfUseful: coachingOpeningQuestion(mode),
        conversation: history.map((turn) => ({ role: turn.role, content: turn.content })),
      },
      jsonSchema: { name: 'apm_coach_reply', schema: coachSchema },
      temperature: mode === 'executive_review' ? 0 : 0.25,
      maxTokens: 900,
    },
  });

  await supabaseRest(input.env, input.accessToken, '/rest/v1/coaching_turns', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ user_id: input.userId, session_id: session.id, role: 'assistant', content: result.reply.slice(0, 8000) }]),
  });
  await supabaseRest(input.env, input.accessToken, `/rest/v1/coaching_sessions?id=eq.${encodeURIComponent(session.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ turn_count: session.turn_count + 1, mode, friction_summary: input.message.slice(0, 500), closure_directive: result.nextAction, updated_at: new Date().toISOString() }),
  }).catch(async () => {
    await supabaseRest(input.env, input.accessToken, `/rest/v1/coaching_sessions?id=eq.${encodeURIComponent(session.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ turn_count: session.turn_count + 1, mode, friction_summary: input.message.slice(0, 500), closure_directive: result.nextAction }),
    });
  });

  return { sessionId: session.id, mode, reply: result.reply, closureReady: result.closureReady, nextAction: result.nextAction ?? undefined };
}

export async function closeCoachingSession(input: { env: ApiEnv; accessToken: string; userId: string; sessionId: string }): Promise<void> {
  await supabaseRest(input.env, input.accessToken, `/rest/v1/coaching_sessions?id=eq.${encodeURIComponent(input.sessionId)}&user_id=eq.${encodeURIComponent(input.userId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString() }),
  });
}
