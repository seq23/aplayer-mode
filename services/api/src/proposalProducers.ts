import type { ActionRecord, IntegrationConnection, LifeGraphSnapshot, RadarItem } from '@apm/domain';
import { buildRadarItems } from '@apm/radar';
import { z } from 'zod';
import { approveAndMaybeExecuteAction, authorizeAction, prepareAction } from './actionEngine';
import { getValidConnectorToken } from './connectors/oauth';
import { readReplyTarget, replyTarget, sendThreadReply } from './connectors/reply';
import { SERVICE_ROLE_TOKEN, restErrorMessage, serviceRpc } from './db';
import { entitlementIsUsable } from './entitlement';
import type { ApiEnv } from './env';
import { getLifeGraph } from './lifeGraphRepository';
import { activeCalendar, calendarMove, canMove, executeSuiteCalendarMove, firstClearSlot, movableEventIds } from './suiteCalendar';

export const SUITE_PROPOSAL_PREFIX = 'suite:';
type ConnectorInput = Omit<Parameters<typeof getValidConnectorToken>[0], 'connectionId'>;
type SuiteProposalKind = 'reply' | 'calendar_fix';
type Domain = 'email' | 'calendar';

type Proposal = { key: string; payload: Record<string, unknown>; reason: string };
type ProducerContext = ConnectorInput & { graph: LifeGraphSnapshot; now: Date; radar: RadarItem[]; seen: Set<string> };
type Producer = {
  kind: SuiteProposalKind;
  domain: Domain;
  actionType: string;
  permissionType: string;
  propose(context: ProducerContext): AsyncGenerator<Proposal, string | undefined>;
};

const replyDraft = replyTarget.extend({ body: z.string().min(1).max(1000), connectionId: z.string().uuid(), signalId: z.string().uuid(), expiresAt: z.iso.datetime() });
type Graph = LifeGraphSnapshot;
export function suiteEntitled(entitlement: Graph['entitlement']): boolean {
  return entitlementIsUsable(entitlement) && (entitlement?.plan === 'life_os' || entitlement?.plan === 'autopilot');
}

export function suitePermission(graph: Graph, kind: unknown) {
  const producer = proposalProducers.find((entry) => entry.kind === kind);
  return producer && graph.permissions.find((p) => p.domain === producer.domain && p.actionType === producer.permissionType);
}

function canWrite(connection: IntegrationConnection, domain: Domain): boolean {
  if (connection.kind !== domain || connection.status !== 'connected' || connection.pausedAt) return false;
  const scopes = connection.scopes.map((scope) => scope.toLowerCase());
  const required = connection.provider === 'google'
    ? (domain === 'email' ? ['gmail.send', 'gmail.compose'] : ['calendar.events', 'calendar']).map((scope) => `https://www.googleapis.com/auth/${scope}`)
    : connection.provider === 'microsoft' ? (domain === 'email' ? ['mail.send'] : ['calendars.readwrite']) : [];
  return required.some((scope) => scopes.includes(scope));
}

async function sourceKey(kind: SuiteProposalKind, ...parts: string[]): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return `${SUITE_PROPOSAL_PREFIX}${kind}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function* replies(context: ProducerContext): ReturnType<Producer['propose']> {
  const { graph, radar, seen } = context;
  const accounts = graph.connections.filter((connection) => canWrite(connection, 'email'));
  if (!accounts.length) return 'EMAIL_CONNECTOR_MISSING_OR_READ_ONLY';
  let checked = 0;
  for (const item of radar.filter((entry) => entry.reasonCodes.includes('email.reply_owed'))) {
    const signal = graph.messageSignals.find((entry) => item.id === `radar:reply_owed:${entry.id}`);
    const account = accounts.find((entry) => entry.id === signal?.connectionId && entry.provider === signal?.provider);
    if (!signal?.externalThreadId || !account?.accountLabel) continue;
    const key = await sourceKey('reply', account.id, signal.externalMessageId);
    if (seen.has(key)) continue;
    if (checked >= 8) break;
    checked += 1;
    const auth = await getValidConnectorToken({ ...context, connectionId: account.id });
    if (auth.provider !== signal.provider) continue;
    const target = await readReplyTarget(auth, signal.externalMessageId, signal.externalThreadId, account.accountLabel);
    if (!target) continue;
    // A receipt acknowledgement. The extracted signal can identify a request, but its
    // untrusted text never becomes sendable text or promises a decision, date or payment.
    yield {
      key, reason: 'Reply to an email',
      payload: { ...target, provider: account.provider, connectionId: account.id, account: account.label && account.label !== account.accountLabel ? `${account.label} (${account.accountLabel})` : account.accountLabel, signalId: signal.id,
        expiresAt: new Date(Date.parse(signal.observedAt) + 14 * 86_400_000).toISOString(),
        body: 'Thanks for your message. I’ve received your request and wanted to acknowledge it.' },
    };
  }
}

async function* calendarFixes(context: ProducerContext): ReturnType<Producer['propose']> {
  const { graph, radar, now, seen } = context;
  const accounts = graph.connections.filter((connection) => canWrite(connection, 'calendar'));
  if (!accounts.length) return 'CALENDAR_CONNECTOR_MISSING_OR_READ_ONLY';
  if (graph.personalOS?.activeMode === 'deep_work') return;
  const conflicts = radar.filter((item) => item.reasonCodes.includes('calendar.busy_overlap') || item.reasonCodes.includes('calendar.overload'))
    .sort((a, b) => Number(a.reasonCodes.includes('calendar.overload')) - Number(b.reasonCodes.includes('calendar.overload')));
  if (!conflicts.length) return;
  const eligible = new Set(await movableEventIds(context));
  for (const conflict of conflicts) {
    const overload = conflict.reasonCodes.includes('calendar.overload');
    const ids = overload ? conflict.sourceRefs.map((source) => source.sourceRef) : conflict.id.slice('radar:calendar_conflict:'.length).split(':');
    const pair = graph.calendarEvents.filter((event) => ids.includes(event.id));
    if (!overload && (pair.length !== 2 || pair.some((event) => Date.parse(event.startsAt) <= now.getTime()))) continue;
    // Prefer moving the shorter flexible block. Produce one independent fix until it
    // has been decided, so two outstanding proposals cannot reserve the same opening.
    pair.sort((a, b) => (Date.parse(a.endsAt) - Date.parse(a.startsAt)) - (Date.parse(b.endsAt) - Date.parse(b.startsAt)));
    for (const event of pair) {
      const account = accounts.find((entry) => entry.id === event.connectionId && entry.provider === event.provider);
      if (!account || !eligible.has(event.id) || !canMove(event) || Date.parse(event.startsAt) <= now.getTime()) continue;
      const key = await sourceKey('calendar_fix', account.id, event.externalEventId, new Date(event.startsAt).toISOString());
      if (seen.has(key)) continue;
      if (graph.actions.some((entry) => entry.status === 'prepared' && entry.payload.suiteProposal === 'calendar_fix'
        && Date.parse(String(entry.payload.originalStartsAt)) > now.getTime())) return;
      const after = new Date(Math.max(...pair.map((entry) => Date.parse(entry.endsAt)))).toISOString();
      const slot = firstClearSlot(event, after, graph, now, overload);
      if (!slot) continue;
      const move = calendarMove.parse({
        ...slot, connectionId: account.id, eventId: event.id, externalEventId: event.externalEventId,
        title: event.title, originalStartsAt: new Date(event.startsAt).toISOString(), originalEndsAt: new Date(event.endsAt).toISOString(),
        sourceVersion: event.sourceVersion, timezone: graph.identity.timezone || 'UTC',
      });
      yield { key, reason: overload ? 'Make room on a crowded day' : 'Resolve a calendar clash', payload: { ...move, provider: account.provider, account: account.label ?? account.accountLabel ?? account.provider } };
      return;
    }
  }
  return 'NO_SAFE_CALENDAR_MOVE';
}

export const proposalProducers: readonly Producer[] = [
  { kind: 'reply', domain: 'email', actionType: 'email.send', permissionType: 'send', propose: replies },
  { kind: 'calendar_fix', domain: 'calendar', actionType: 'calendar.reschedule', permissionType: 'event_write', propose: calendarFixes },
];

export async function executeSuiteReply(payload: Record<string, unknown>, graph: Graph, input: ConnectorInput, now = new Date()): Promise<string> {
  const draft = replyDraft.parse(payload);
  const signal = graph.messageSignals.find((entry) => entry.id === draft.signalId && entry.connectionId === draft.connectionId
    && entry.externalMessageId === draft.messageId && entry.externalThreadId === draft.threadId);
  const account = graph.connections.find((entry) => entry.id === draft.connectionId && entry.provider === signal?.provider && canWrite(entry, 'email'));
  if (Date.parse(draft.expiresAt) <= now.getTime() || !signal || !account?.accountLabel
    || !buildRadarItems(graph, { now, maxItems: Number.POSITIVE_INFINITY }).some((item) => item.id === `radar:reply_owed:${signal.id}`)) {
    throw new Error('action_proposal_stale');
  }
  const auth = await getValidConnectorToken({ ...input, connectionId: draft.connectionId });
  const target = await readReplyTarget(auth, draft.messageId, draft.threadId, account.accountLabel);
  if (!target || auth.provider !== signal.provider || target.to !== draft.to || target.subject !== draft.subject || target.internetId !== draft.internetId) {
    throw new Error('action_proposal_stale');
  }
  return sendThreadReply(auth, target, draft.body);
}

export function approveSuiteProposal(action: ActionRecord, graph: Graph, input: ConnectorInput, now = new Date()) {
  if (!suiteEntitled(graph.entitlement)) throw new Error('action_not_authorized:entitlement_too_low');
  const kind = action.payload.suiteProposal;
  return approveAndMaybeExecuteAction({
    ...input, action, entitlement: graph.entitlement, permission: suitePermission(graph, kind),
    execute: (claimed) => {
      if (kind === 'reply') return executeSuiteReply(claimed.payload, graph, input, now);
      if (kind === 'calendar_fix') return executeSuiteCalendarMove(claimed.payload, graph, input, now);
      throw new Error('action_invalid_state');
    },
  });
}

export async function prepareSuiteProposals(env: ApiEnv, graph: Graph, now: Date, accessToken = SERVICE_ROLE_TOKEN) {
  const result = { prepared: 0, stops: [] as string[] };
  if (!suiteEntitled(graph.entitlement)) return result;
  const context: ProducerContext = {
    env, accessToken, userId: graph.identity.userId, graph, now,
    radar: buildRadarItems(graph, { now, maxItems: Number.POSITIVE_INFINITY }),
    seen: new Set(graph.actions.map((action) => action.idempotencyKey)),
  };
  for (const producer of proposalProducers) {
    const permission = suitePermission(graph, producer.kind);
    if (!authorizeAction({ ...context, domain: producer.domain, requestedLevel: 3, permission, entitlement: graph.entitlement }).allowed) continue;
    const iterator = producer.propose(context);
    try {
      let count = 0;
      while (count < 3) {
        const next = await iterator.next();
        if (next.done) {
          if (next.value) result.stops.push(next.value);
          break;
        }
        const { key, payload, reason } = next.value;
        try {
          const { replayed } = await prepareAction({
            ...context, domain: producer.domain, actionType: producer.actionType,
            payload: { ...payload, suiteProposal: producer.kind }, reason, idempotencyKey: key,
            permission, entitlement: graph.entitlement,
          });
          if (!replayed) result.prepared += 1;
        } catch (error) {
          // A concurrent run may have found a different open slot for the same event.
          if (!(error instanceof Error) || !isIdempotencyConflict(error)) throw error;
        }
        context.seen.add(key);
        count += 1;
      }
    } catch {
      result.stops.push(producer.kind === 'reply' ? 'REPLY_PRODUCER_UNAVAILABLE' : 'CALENDAR_PRODUCER_UNAVAILABLE');
    } finally {
      await iterator.return(undefined);
    }
  }
  return result;
}

function isIdempotencyConflict(error: unknown) {
  return restErrorMessage(error) === 'action_idempotency_conflict';
}

export async function runSuiteProposals(env: ApiEnv, now: Date): Promise<string | undefined> {
  if (now.getUTCMinutes() % 15 !== 0) return;
  const output = (count: number, stops: string[]) =>
    `OUTPUT ${count} suite_proposals_prepared${stops.length ? ` NAMED STOP [${stops.join(', ')}]` : ''}`;
  if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_URL) return output(0, ['SUITE_PROPOSALS_NO_SERVICE_CREDENTIAL']);
  const users = await serviceRpc<string[]>(env, 'apm_service_suite_proposal_candidates', {
    p_slot: now.getUTCHours() * 4 + now.getUTCMinutes() / 15,
  });
  let total = 0;
  const stops = new Set<string>();
  for (const userId of users) {
    try {
      const graph = await getLifeGraph(env, SERVICE_ROLE_TOKEN, userId);
      const { prepared, stops: userStops } = await prepareSuiteProposals(env, graph, now);
      total += prepared;
      userStops.forEach((stop) => stops.add(stop));
    } catch {
      stops.add('SUITE_PROPOSALS_USER_UNAVAILABLE');
    }
  }
  if (!total && !stops.size) stops.add('NO_ELIGIBLE_PROPOSALS');
  return output(total, [...stops]);
}
