import {
  evaluateInferencePrivacy,
  type DataClass,
  type InferenceRoutePolicy,
  type RetentionClass,
} from '@apm/privacy';

export type CostClass = 'zero' | 'low' | 'standard' | 'premium';
export type RouteStatus = 'candidate' | 'approved' | 'restricted' | 'disabled';

export type ModelCapability =
  | 'classification'
  | 'extraction'
  | 'reasoning'
  | 'planning'
  | 'conversation'
  | 'structured_output'
  | 'tool_planning';

export interface ModelRoute {
  routeId: string;
  modelId: string;
  providerId: string;
  status: RouteStatus;
  costClass: CostClass;
  capabilities: ModelCapability[];
  dataClassesAllowed: DataClass[];
  trainingAllowed: boolean;
  retention: RetentionClass;
  approvedForHighlySensitive: boolean;
  qualityScore: number;
  reliabilityScore: number;
  latencyScore: number;
  lastPolicyReviewedAt: string;
  lastEvalRunAt?: string;
}

export interface RouteRequest {
  dataClass: DataClass;
  requiredCapabilities: ModelCapability[];
  minimumQualityScore?: number;
}

export interface RouteSelection {
  route: ModelRoute;
  reason: 'selected';
}

const costRank: Record<CostClass, number> = {
  zero: 0,
  low: 1,
  standard: 2,
  premium: 3,
};

function toPrivacyPolicy(route: ModelRoute): InferenceRoutePolicy {
  return {
    routeId: route.routeId,
    trainingAllowed: route.trainingAllowed,
    retention: route.retention,
    approvedForHighlySensitive: route.approvedForHighlySensitive,
    enabled: route.status === 'approved',
  };
}

export function isRouteEligible(route: ModelRoute, request: RouteRequest): boolean {
  if (route.status !== 'approved') return false;
  if (!route.dataClassesAllowed.includes(request.dataClass)) return false;
  if (!request.requiredCapabilities.every((capability) => route.capabilities.includes(capability))) {
    return false;
  }

  if ((request.minimumQualityScore ?? 0) > route.qualityScore) return false;

  return evaluateInferencePrivacy(request.dataClass, toPrivacyPolicy(route)).allowed;
}

export function selectModelRoute(
  routes: ModelRoute[],
  request: RouteRequest,
): RouteSelection | null {
  const eligible = routes.filter((route) => isRouteEligible(route, request));

  eligible.sort((a, b) => {
    const privacyEquivalentCost = costRank[a.costClass] - costRank[b.costClass];
    if (privacyEquivalentCost !== 0) return privacyEquivalentCost;

    if (b.reliabilityScore !== a.reliabilityScore) {
      return b.reliabilityScore - a.reliabilityScore;
    }

    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }

    return b.latencyScore - a.latencyScore;
  });

  const route = eligible[0];
  return route ? { route, reason: 'selected' } : null;
}

export function isGenericFreeRouterAllowed(dataClass: DataClass): boolean {
  return dataClass === 'public_synthetic';
}

export function buildOpenRouterProviderPolicy(route: ModelRoute) {
  if (route.status !== 'approved') {
    throw new Error(`Route ${route.routeId} is not approved`);
  }

  return {
    allow_fallbacks: false,
    data_collection: route.trainingAllowed ? 'allow' : 'deny',
    zdr: route.retention === 'zero',
    only: [route.providerId],
  } as const;
}
