export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type ProductPlan = 'beta' | 'chief_of_staff' | 'life_os' | 'autopilot' | 'household';

export type ProductCapability =
  | 'personal_os'
  | 'today_radar'
  | 'calendar_email_awareness'
  | 'coaching'
  | 'prepare_actions'
  | 'life_os_domains'
  | 'execute_with_approval'
  | 'standing_autopilot'
  | 'household_shared_graph';

export interface ProductPlanPolicy {
  plan: ProductPlan;
  displayName: string;
  promise: string;
  publicAvailability: 'beta' | 'available' | 'waitlist';
  capabilities: ProductCapability[];
}

export const productPlanPolicies: Record<ProductPlan, ProductPlanPolicy> = {
  beta: {
    plan: 'beta',
    displayName: 'Chief of Staff Beta',
    promise: 'APM notices, prioritizes, plans, coaches and prepares supported actions.',
    publicAvailability: 'beta',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions'],
  },
  chief_of_staff: {
    plan: 'chief_of_staff',
    displayName: 'Chief of Staff',
    promise: 'Keep me on top of my life.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions'],
  },
  life_os: {
    plan: 'life_os',
    displayName: 'Life OS',
    promise: 'Carry more of my mental load.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions','life_os_domains','execute_with_approval'],
  },
  autopilot: {
    plan: 'autopilot',
    displayName: 'Autopilot',
    promise: 'Handle approved recurring work inside rules I set.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions','life_os_domains','execute_with_approval','standing_autopilot'],
  },
  household: {
    plan: 'household',
    displayName: 'Household OS',
    promise: 'Coordinate shared household mental load.',
    publicAvailability: 'waitlist',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions','life_os_domains','execute_with_approval','standing_autopilot','household_shared_graph'],
  },
};

export function capabilitiesForPlan(plan: ProductPlan): ProductCapability[] {
  return [...productPlanPolicies[plan].capabilities];
}

export function planHasCapability(plan: ProductPlan, capability: ProductCapability): boolean {
  return productPlanPolicies[plan].capabilities.includes(capability);
}

export function isPubliclySelectablePlan(plan: ProductPlan): boolean {
  return productPlanPolicies[plan].publicAvailability === 'available';
}

export type ActionDomain =
  | 'calendar'
  | 'email'
  | 'routine'
  | 'life_graph'
  | 'purchase'
  | 'notification'
  | 'connector';

export function maxAutonomyForPlan(plan: ProductPlan, domain: ActionDomain): AutonomyLevel {
  if (plan === 'beta' || plan === 'chief_of_staff') return 3;
  if (plan === 'life_os') return 4;
  if (plan === 'autopilot' || plan === 'household') return domain === 'purchase' ? 2 : 5;
  return 0;
}

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
