import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilitiesForPlan,
  decideAuthority,
  isPubliclySelectablePlan,
  maxAutonomyForPlan,
  planHasCapability,
} from '../.test-dist/index.js';

test('individual service levels have increasing autonomy ceilings', () => {
  assert.equal(maxAutonomyForPlan('chief_of_staff', 'calendar'), 3);
  assert.equal(maxAutonomyForPlan('life_os', 'calendar'), 4);
  assert.equal(maxAutonomyForPlan('autopilot', 'calendar'), 5);
  assert.equal(maxAutonomyForPlan('autopilot', 'purchase'), 2);
  assert.equal(maxAutonomyForPlan('household', 'calendar'), 0);
});

test('Household is not publicly selectable', () => {
  assert.equal(isPubliclySelectablePlan('chief_of_staff'), true);
  assert.equal(isPubliclySelectablePlan('life_os'), true);
  assert.equal(isPubliclySelectablePlan('autopilot'), true);
  assert.equal(isPubliclySelectablePlan('household'), false);
  assert.equal(isPubliclySelectablePlan('beta'), false);
});

test('capability matrix keeps Life OS and Autopilot distinct', () => {
  assert.equal(planHasCapability('chief_of_staff', 'life_os_domains'), false);
  assert.equal(planHasCapability('life_os', 'life_os_domains'), true);
  assert.equal(planHasCapability('life_os', 'standing_autopilot'), false);
  assert.equal(planHasCapability('autopilot', 'standing_autopilot'), true);
  assert.deepEqual(capabilitiesForPlan('household'), []);
});

test('entitlement alone never grants action authority', () => {
  const result = decideAuthority({
    userId: 'user-1',
    domain: 'calendar',
    requestedLevel: 4,
    entitlement: { domain: 'calendar', maxAvailableLevel: 5, enabled: true },
    globalExecutionEnabled: true,
    domainExecutionEnabled: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'permission_missing_or_disabled');
});

test('a user permission cannot exceed the product entitlement', () => {
  const result = decideAuthority({
    userId: 'user-1',
    domain: 'calendar',
    requestedLevel: 5,
    permission: { userId: 'user-1', domain: 'calendar', maxLevel: 5, enabled: true, updatedAt: '2026-10-06T00:00:00.000Z' },
    entitlement: { domain: 'calendar', maxAvailableLevel: 4, enabled: true },
    globalExecutionEnabled: true,
    domainExecutionEnabled: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.effectiveLevel, 4);
  assert.equal(result.reason, 'entitlement_too_low');
});
