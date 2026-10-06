export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type ActionDomain =
  | 'calendar'
  | 'email'
  | 'routine'
  | 'life_graph'
  | 'purchase'
  | 'notification'
  | 'connector';

export interface PermissionGrant {
  userId: string;
  domain: ActionDomain;
  maxLevel: AutonomyLevel;
  enabled: boolean;
  updatedAt: string;
}

export interface Entitlement {
  domain: ActionDomain;
  maxAvailableLevel: AutonomyLevel;
  enabled: boolean;
}

export interface AuthorityRequest {
  userId: string;
  domain: ActionDomain;
  requestedLevel: AutonomyLevel;
  permission?: PermissionGrant;
  entitlement?: Entitlement;
  globalExecutionEnabled: boolean;
  domainExecutionEnabled: boolean;
}

export interface AuthorityDecision {
  allowed: boolean;
  effectiveLevel: AutonomyLevel;
  reason:
    | 'allowed'
    | 'global_execution_disabled'
    | 'domain_execution_disabled'
    | 'capability_not_entitled'
    | 'permission_missing_or_disabled'
    | 'permission_too_low'
    | 'entitlement_too_low';
}

export function decideAuthority(request: AuthorityRequest): AuthorityDecision {
  if (!request.globalExecutionEnabled) {
    return { allowed: false, effectiveLevel: 0, reason: 'global_execution_disabled' };
  }

  if (!request.domainExecutionEnabled) {
    return { allowed: false, effectiveLevel: 0, reason: 'domain_execution_disabled' };
  }

  const entitlement = request.entitlement;
  if (!entitlement?.enabled) {
    return { allowed: false, effectiveLevel: 0, reason: 'capability_not_entitled' };
  }

  const permission = request.permission;
  if (!permission?.enabled || permission.userId !== request.userId || permission.domain !== request.domain) {
    return { allowed: false, effectiveLevel: 0, reason: 'permission_missing_or_disabled' };
  }

  const effectiveLevel = Math.min(
    permission.maxLevel,
    entitlement.maxAvailableLevel,
  ) as AutonomyLevel;

  if (entitlement.maxAvailableLevel < request.requestedLevel) {
    return { allowed: false, effectiveLevel, reason: 'entitlement_too_low' };
  }

  if (permission.maxLevel < request.requestedLevel) {
    return { allowed: false, effectiveLevel, reason: 'permission_too_low' };
  }

  return { allowed: true, effectiveLevel, reason: 'allowed' };
}

export function requiresExplicitApproval(level: AutonomyLevel): boolean {
  return level === 4;
}

export function mayExecuteWithoutPerActionApproval(level: AutonomyLevel): boolean {
  return level === 5;
}

export const autonomyLabels: Record<AutonomyLevel, string> = {
  0: 'Observe',
  1: 'Remind',
  2: 'Recommend',
  3: 'Prepare',
  4: 'Approve & execute',
  5: 'Autopilot',
};
