// Connected accounts (0065; owner decision 7 Oct 2026): Autopilot connects several calendars
// and inboxes at once (work AND personal); every other plan gets one of each. The database
// enforces the limit; this module only decides what the app SAYS, so a lower plan sees a
// plain upgrade note naming Autopilot instead of a button that would fail.
import { PLAN_PRICES, planHasCapability, type ProductPlan } from '@apm/policy';
import type { IntegrationConnection, IntegrationKind, SubscriptionEntitlement } from '@apm/domain';

const usable = (entitlement?: SubscriptionEntitlement) =>
  Boolean(entitlement && (entitlement.status === 'active' || entitlement.status === 'trialing'));

export function hasMultiAccount(entitlement?: SubscriptionEntitlement): boolean {
  return usable(entitlement) && planHasCapability(entitlement!.plan as ProductPlan, 'multi_account');
}

/** Cloud accounts of a kind the user still has (paused ones included; disconnected ones gone). */
export function accountsOfKind(connections: IntegrationConnection[], kind: IntegrationKind): IntegrationConnection[] {
  return connections
    .filter((item) => item.kind === kind && item.provider !== 'device' && item.status !== 'disconnected')
    .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
}

export function liveAccountsOfKind(connections: IntegrationConnection[], kind: IntegrationKind): IntegrationConnection[] {
  return accountsOfKind(connections, kind).filter((item) => !item.pausedAt);
}

/** The user's own name first ("Work"), then the provider's account name. */
export function accountName(connection: IntegrationConnection): string {
  return connection.label ?? connection.accountLabel ?? 'Connected account';
}

export const KIND_NOUN: Record<IntegrationKind, string> = { calendar: 'calendar', email: 'inbox' };

/** Whether "Add another account" is a button, or an upgrade note naming Autopilot. */
export function addAnotherAccount(entitlement: SubscriptionEntitlement | undefined, connections: IntegrationConnection[], kind: IntegrationKind):
  { allowed: true } | { allowed: false; upgradeNote: string } {
  if (hasMultiAccount(entitlement) || liveAccountsOfKind(connections, kind).length === 0) return { allowed: true };
  return {
    allowed: false,
    upgradeNote: `Your plan includes one ${KIND_NOUN[kind]}. Connecting another (work and personal at once) is part of ${PLAN_PRICES.autopilot.displayName}.`,
  };
}

/** Plain words for a paused account: what it means, and how to get it back. */
export function pausedNote(connection: IntegrationConnection, entitlement?: SubscriptionEntitlement): string | undefined {
  if (!connection.pausedAt) return undefined;
  const noun = KIND_NOUN[connection.kind];
  return hasMultiAccount(entitlement)
    ? `Paused: APM is not reading or acting on this ${noun}. Reactivate it to use it again.`
    : `Paused: your plan includes one ${noun}, so APM is not reading or acting on this one. Nothing was deleted. Upgrade to ${PLAN_PRICES.autopilot.displayName} to reactivate it, or make it your primary ${noun} instead.`;
}

/**
 * Which account an item came from, shown on Today only when more than one account of that
 * kind is connected (a single-account user never sees the noise).
 */
export function sourceAccountLabel(connections: IntegrationConnection[], kind: IntegrationKind, connectionIds: string[] | undefined): string | undefined {
  if (!connectionIds?.length || accountsOfKind(connections, kind).length < 2) return undefined;
  const names = connectionIds
    .map((id) => connections.find((item) => item.id === id))
    .filter((item): item is IntegrationConnection => Boolean(item))
    .map(accountName);
  return names.length ? [...new Set(names)].join(' + ') : undefined;
}
