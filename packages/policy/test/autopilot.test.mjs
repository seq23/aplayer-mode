import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStandingAuthority,
  evaluateCalendarStandingProposal,
  isStandingActionClass,
  localMoment,
  standingActionClasses,
  standingForbiddenReason,
  validateStandingConstraints,
} from '../.test-dist/index.js';

const calendarRule = {
  timezone: 'America/Chicago', weekdays: [1, 2, 3, 4, 5], windowStart: '06:00', windowEnd: '09:00',
  maxDurationMinutes: 90, maxPerDay: 1, horizonDays: 14, collision: 'never_overlap_busy',
};

test('only reversible calendar.create and email.draft can be standing classes', () => {
  assert.deepEqual(Object.keys(standingActionClasses).sort(), ['calendar.create', 'email.draft']);
  for (const policy of Object.values(standingActionClasses)) assert.equal(policy.reversible, true);
  for (const forbidden of ['purchase.order', 'healthcare.book', 'financial.pay_bill', 'email.send', 'calendar.update', 'connector.disconnect', 'life_graph.delete']) {
    assert.equal(isStandingActionClass(forbidden), false, forbidden);
    assert.ok(standingForbiddenReason(forbidden), forbidden);
  }
  assert.equal(standingForbiddenReason('calendar.create'), undefined);
  assert.match(standingForbiddenReason('purchase.order'), /purchasing/);
});

test('constraint validation mirrors the database shape', () => {
  assert.deepEqual(validateStandingConstraints('calendar.create', calendarRule), []);
  assert.deepEqual(validateStandingConstraints('calendar.create', { ...calendarRule, extra: 1 }), ['unknown:extra']);
  assert.ok(validateStandingConstraints('calendar.create', { ...calendarRule, windowEnd: '05:00' }).includes('window'));
  assert.ok(validateStandingConstraints('calendar.create', { ...calendarRule, maxDurationMinutes: 240 }).includes('maxDurationMinutes'));
  assert.ok(validateStandingConstraints('calendar.create', { ...calendarRule, weekdays: [1, 1] }).includes('weekdays'));
  assert.ok(validateStandingConstraints('calendar.create', { ...calendarRule, timezone: 'Mars/Olympus' }).includes('timezone'));
  assert.ok(validateStandingConstraints('calendar.create', { ...calendarRule, collision: 'override' }).includes('collision'));
  const email = { timezone: 'Europe/London', weekdays: [1, 2, 3, 4, 5], windowStart: '08:00', windowEnd: '18:00', maxPerDay: 3, allowedRecipientDomains: ['school.example.org'] };
  assert.deepEqual(validateStandingConstraints('email.draft', email), []);
  assert.ok(validateStandingConstraints('email.draft', { ...email, allowedRecipientDomains: [] }).includes('allowedRecipientDomains'));
  assert.ok(validateStandingConstraints('email.draft', { ...email, allowedRecipientDomains: ['Not A Domain'] }).includes('allowedRecipientDomains'));
});

test('localMoment reads wall-clock time and ISO weekday in the rule timezone', () => {
  // 2026-10-05 is a Monday. 12:30Z is 07:30 in Chicago (CDT).
  assert.deepEqual(localMoment(new Date('2026-10-05T12:30:00Z'), 'America/Chicago'), { date: '2026-10-05', isoWeekday: 1, minutes: 450 });
  assert.equal(localMoment(new Date('2026-10-05T02:00:00Z'), 'America/Chicago').isoWeekday, 7);
});

test('calendar proposals must fit duration, horizon, weekday, window, collision and cap', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const base = { constraints: calendarRule, now, busy: [], claimedOnLocalDay: 0 };
  // Monday 07:00–08:00 Chicago.
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T13:00:00Z' }), 'allowed');
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T14:00:00Z' }), 'outside_rule');
  // Saturday.
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: '2026-10-10T12:00:00Z', endsAt: '2026-10-10T13:00:00Z' }), 'outside_rule');
  // Ends after 09:00 local.
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: '2026-10-05T13:30:00Z', endsAt: '2026-10-05T14:30:00Z' }), 'outside_rule');
  // Beyond the 14-day horizon.
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: '2026-10-26T12:00:00Z', endsAt: '2026-10-26T13:00:00Z' }), 'outside_rule');
  // In the past.
  assert.equal(evaluateCalendarStandingProposal({ ...base, now: new Date('2026-10-06T00:00:00Z'), startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T13:00:00Z' }), 'outside_rule');
  assert.equal(evaluateCalendarStandingProposal({ ...base, busy: [{ startsAt: '2026-10-05T12:30:00Z', endsAt: '2026-10-05T12:45:00Z' }], startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T13:00:00Z' }), 'collision');
  assert.equal(evaluateCalendarStandingProposal({ ...base, claimedOnLocalDay: 1, startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T13:00:00Z' }), 'rate_limited');
  assert.equal(evaluateCalendarStandingProposal({ ...base, startsAt: 'nope', endsAt: '2026-10-05T13:00:00Z' }), 'invalid_payload');
});

test('standing authority needs entitlement, level-5 permission, an active rule, activation and every switch', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const ok = {
    userId: 'u1', actionClass: 'calendar.create', plan: 'autopilot', planUsable: true,
    permission: { userId: 'u1', domain: 'calendar', maxLevel: 5, enabled: true, updatedAt: now.toISOString() },
    rule: { status: 'active', expiresAt: '2026-11-01T00:00:00Z' },
    classActivated: true, masterPaused: false,
    globalExecutionEnabled: true, domainExecutionEnabled: true, autopilotExecutionEnabled: true, now,
  };
  assert.deepEqual(decideStandingAuthority(ok), { allowed: true, reason: 'allowed' });
  // Buying Autopilot without granting permission is not authority.
  assert.equal(decideStandingAuthority({ ...ok, permission: undefined }).reason, 'permission_missing_or_disabled');
  assert.equal(decideStandingAuthority({ ...ok, permission: { ...ok.permission, maxLevel: 4 } }).reason, 'permission_too_low');
  assert.equal(decideStandingAuthority({ ...ok, plan: 'life_os' }).reason, 'entitlement_too_low');
  assert.equal(decideStandingAuthority({ ...ok, planUsable: false }).reason, 'capability_not_entitled');
  assert.equal(decideStandingAuthority({ ...ok, rule: undefined }).reason, 'rule_inactive');
  assert.equal(decideStandingAuthority({ ...ok, rule: { status: 'paused', expiresAt: ok.rule.expiresAt } }).reason, 'rule_inactive');
  assert.equal(decideStandingAuthority({ ...ok, rule: { status: 'active', expiresAt: '2026-10-01T00:00:00Z' } }).reason, 'rule_expired');
  assert.equal(decideStandingAuthority({ ...ok, classActivated: false }).reason, 'class_not_activated');
  assert.equal(decideStandingAuthority({ ...ok, masterPaused: true }).reason, 'autopilot_paused');
  assert.equal(decideStandingAuthority({ ...ok, autopilotExecutionEnabled: false }).reason, 'autopilot_execution_disabled');
  assert.equal(decideStandingAuthority({ ...ok, globalExecutionEnabled: false }).reason, 'global_execution_disabled');
  assert.equal(decideStandingAuthority({ ...ok, domainExecutionEnabled: false }).reason, 'domain_execution_disabled');
  assert.equal(decideStandingAuthority({ ...ok, actionClass: 'purchase.order' }).reason, 'unsupported_action_class');
  assert.equal(decideStandingAuthority({ ...ok, actionClass: 'email.send' }).reason, 'unsupported_action_class');
});
