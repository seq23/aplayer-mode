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
    promise: 'APM decides the day.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions'],
  },
  life_os: {
    plan: 'life_os',
    displayName: 'Life OS',
    promise: 'APM remembers and prepares: everything in Chief of Staff, across more of your life.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions','life_os_domains','execute_with_approval'],
  },
  autopilot: {
    plan: 'autopilot',
    displayName: 'Autopilot',
    promise: 'APM does: everything in Life OS, plus approved work carried out inside rules you set.',
    publicAvailability: 'available',
    capabilities: ['personal_os','today_radar','calendar_email_awareness','coaching','prepare_actions','life_os_domains','execute_with_approval','standing_autopilot'],
  },
  household: {
    plan: 'household',
    displayName: 'Household OS',
    promise: 'Coordinate shared household mental load.',
    publicAvailability: 'waitlist',
    capabilities: [],
  },
};

/**
 * THE price list (owner-decided, final, 2026-10-07; ADR-0004). Every doc that
 * states a price is pinned to these constants by packages/policy/test/pricing.test.mjs,
 * and the API's plan labels are derived from them. Change a price here and in
 * ADR-0004 together, never in a doc alone.
 *
 * Tiers are cumulative and every tier reduces cognitive load (upper tiers more).
 * A price buys capability, never autonomy: authority still needs explicit user
 * permission AND server policy AND kill switches (see decideAuthority).
 */
export type PaidPlan = 'chief_of_staff' | 'life_os' | 'autopilot';

export interface PlanPrice {
  plan: PaidPlan;
  displayName: string;
  /** The one-line job of the tier. */
  tagline: string;
  /** USD cents per month, before any intro offer. */
  monthlyUsdCents: number;
  /** The tier this one fully includes (cumulative ladder). */
  includes: PaidPlan | null;
}

export const PLAN_PRICES: Readonly<Record<PaidPlan, PlanPrice>> = {
  chief_of_staff: { plan: 'chief_of_staff', displayName: 'Chief of Staff', tagline: 'decides the day', monthlyUsdCents: 2499, includes: null },
  life_os: { plan: 'life_os', displayName: 'Life OS', tagline: 'remembers and prepares', monthlyUsdCents: 3999, includes: 'chief_of_staff' },
  autopilot: { plan: 'autopilot', displayName: 'Autopilot', tagline: 'does', monthlyUsdCents: 7999, includes: 'life_os' },
};

/** Intro offers exist on Chief of Staff only. */
export const CHIEF_OF_STAFF_INTRO_OFFERS = {
  /** First 100 subscribers: the intro price for as long as they stay continuously subscribed. */
  founding100: { subscribers: 100, monthlyUsdCents: 999, lockedWhileContinuouslySubscribed: true },
  /** Everyone else: the intro price for the first months, then the standard price. */
  introductory: { monthlyUsdCents: 999, months: 3, thenMonthlyUsdCents: 2499 },
} as const;

/** Billing is store in-app subscriptions only (Phase D, not built). */
export const BILLING_CHANNELS = ['app_store', 'google_play'] as const;
export type BillingChannel = (typeof BILLING_CHANNELS)[number];

export function formatUsdCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('price_cents_invalid');
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** The plan labels the API returns; derived from PLAN_PRICES, never typed by hand. */
export const planPriceLabels: Readonly<Record<ProductPlan, string>> = {
  beta: 'Free during beta',
  chief_of_staff: `${formatUsdCents(PLAN_PRICES.chief_of_staff.monthlyUsdCents)}/mo · founding 100: ${formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents)}/mo locked · everyone else: ${formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents)}/mo for the first ${CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months`,
  life_os: `${formatUsdCents(PLAN_PRICES.life_os.monthlyUsdCents)}/mo · includes Chief of Staff`,
  autopilot: `${formatUsdCents(PLAN_PRICES.autopilot.monthlyUsdCents)}/mo · includes Life OS`,
  household: 'Waitlist only',
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
  | 'connector'
  | 'appointment'
  | 'subscription';

export function maxAutonomyForPlan(plan: ProductPlan, domain: ActionDomain): AutonomyLevel {
  if (plan === 'beta' || plan === 'chief_of_staff') return 3;
  if (plan === 'life_os') return 4;
  if (plan === 'autopilot') return domain === 'purchase' ? 2 : 5;
  if (plan === 'household') return 0;
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

// ---------------------------------------------------------------------------
// Phase C — Autopilot standing rules (docs/31-AUTOPILOT-PHASE-C.md)
//
// The database (migration 0018) is the authority boundary; these deterministic
// helpers mirror it so the Worker can fail closed early and the app can explain
// a decision before it asks the server.
// ---------------------------------------------------------------------------

export type StandingActionClass =
  | 'calendar.create'
  | 'email.draft'
  | 'email.send'
  | 'calendar.reschedule'
  | 'calendar.decline'
  | 'appointment.book'
  | 'subscription.cancel';

export type StandingUndo = 'delete_event' | 'delete_draft' | 'restore_time' | 'reaccept' | 'none';

export interface StandingActionClassPolicy {
  actionClass: StandingActionClass;
  /** Permission/entitlement domain (permissions.domain). */
  domain: Extract<ActionDomain, 'calendar' | 'email' | 'appointment' | 'subscription'>;
  /** The provider connector that executes it — and whose kill switch governs it. */
  connector: 'calendar' | 'email';
  actionType: StandingActionClass;
  label: string;
  reversible: boolean;
  undo: StandingUndo;
  /** Shown on the done-list: what Undo does, or a clear "Can't undo". */
  undoLabel: string;
}

/**
 * The whole allow-list (mirrors public.autopilot_action_classes, migration 0033;
 * expanded from two classes by ADR-0003, the owner's ruling of 6 Oct 2026).
 * Anything not listed here can never be a standing rule.
 */
export const standingActionClasses: Record<StandingActionClass, StandingActionClassPolicy> = {
  'calendar.create': {
    actionClass: 'calendar.create', domain: 'calendar', connector: 'calendar', actionType: 'calendar.create',
    label: 'Schedule a new calendar block (e.g. a routine)', reversible: true, undo: 'delete_event',
    undoLabel: 'Undo removes the event APM created.',
  },
  'email.draft': {
    actionClass: 'email.draft', domain: 'email', connector: 'email', actionType: 'email.draft',
    label: 'Prepare an email draft', reversible: true, undo: 'delete_draft',
    undoLabel: 'Undo deletes the draft APM prepared.',
  },
  'email.send': {
    actionClass: 'email.send', domain: 'email', connector: 'email', actionType: 'email.send',
    label: 'Send scheduling replies, follow-ups, confirmations and your templates', reversible: false, undo: 'none',
    undoLabel: "Can't undo: a sent message cannot be recalled.",
  },
  'calendar.reschedule': {
    actionClass: 'calendar.reschedule', domain: 'calendar', connector: 'calendar', actionType: 'calendar.reschedule',
    label: 'Move flexible meetings (never Deep Work or foreground blocks)', reversible: true, undo: 'restore_time',
    undoLabel: 'Undo moves the meeting back to its original time (attendees are notified again).',
  },
  'calendar.decline': {
    actionClass: 'calendar.decline', domain: 'calendar', connector: 'calendar', actionType: 'calendar.decline',
    label: 'Decline invitations that break your boundaries, with a polite note', reversible: true, undo: 'reaccept',
    undoLabel: 'Undo re-accepts the invitation; the organiser has already seen the decline note.',
  },
  'appointment.book': {
    actionClass: 'appointment.book', domain: 'appointment', connector: 'email', actionType: 'appointment.book',
    label: 'Request FREE appointments from providers you list', reversible: false, undo: 'none',
    undoLabel: "Can't undo: the request was emailed. Reply to the provider to cancel.",
  },
  'subscription.cancel': {
    actionClass: 'subscription.cancel', domain: 'subscription', connector: 'email', actionType: 'subscription.cancel',
    label: 'Cancel subscriptions by email (saves money, never spends it)', reversible: false, undo: 'none',
    undoLabel: "Can't undo: the cancellation was emailed. Re-subscribing would spend money, so APM never does it.",
  },
};

/**
 * Rejected by name, in the database and in the app. Autopilot may save money
 * but never spend it, and never makes clinical choices.
 */
export const forbiddenStandingActions: ReadonlyArray<{ match: string; reason: string }> = [
  { match: 'purchase.*', reason: 'No autonomous purchasing.' },
  { match: 'payment.*', reason: 'No payments and no entering card or payment details.' },
  { match: 'subscription.upgrade', reason: 'Never upgrades a plan: Autopilot may save money, never spend it.' },
  { match: 'subscription.signup', reason: 'Never signs up for anything that can charge you.' },
  { match: 'healthcare.*', reason: 'No clinical or healthcare decisions; appointments are scheduling logistics only.' },
  { match: 'financial.*', reason: 'No banking, bill payment, transfers or any other money movement.' },
  { match: 'calendar.update', reason: 'Generic event edits can override commitments; only rule-bound moves and declines.' },
  { match: 'connector.*', reason: 'Connector administration always needs the user.' },
];

export function isStandingActionClass(value: string): value is StandingActionClass {
  return Object.prototype.hasOwnProperty.call(standingActionClasses, value);
}

export function standingForbiddenReason(actionClass: string): string | undefined {
  for (const rule of forbiddenStandingActions) {
    const prefix = rule.match.endsWith('.*') ? rule.match.slice(0, -1) : undefined;
    if (prefix ? actionClass.startsWith(prefix) : actionClass === rule.match) return rule.reason;
  }
  return isStandingActionClass(actionClass) ? undefined : 'Not a supported Autopilot action class.';
}

export interface StandingWindow {
  timezone: string;
  /** ISO weekdays, Monday = 1 … Sunday = 7. */
  weekdays: number[];
  windowStart: string;
  windowEnd: string;
  maxPerDay: number;
}

export interface CalendarStandingConstraints extends StandingWindow {
  maxDurationMinutes: number;
  horizonDays: number;
  collision: 'never_overlap_busy';
}

export interface EmailDraftStandingConstraints extends StandingWindow {
  allowedRecipientDomains: string[];
}

export type EmailSendKind = 'scheduling_reply' | 'follow_up' | 'confirmation' | 'template';
export interface EmailTemplate { id: string; label: string; subject: string; body: string }
export interface EmailSendStandingConstraints extends StandingWindow {
  maxPerRecipientPerDay: number;
  allowedKinds: EmailSendKind[];
  allowedRecipients: string[];
  allowedRecipientDomains: string[];
  templates: EmailTemplate[];
}

export interface EventCriteria { matchTitleKeywords: string[]; maxAttendees: number; protectedTitleKeywords: string[] }
export interface RescheduleStandingConstraints extends StandingWindow, EventCriteria {
  horizonDays: number;
  maxShiftDays: number;
  collision: 'never_overlap_busy';
}
export interface Boundary { weekdays: number[]; start: string; end: string }
export interface DeclineStandingConstraints extends EventCriteria {
  timezone: string;
  maxPerDay: number;
  horizonDays: number;
  boundaries: Boundary[];
  declineNote?: string;
}
export type ProviderCategory = 'medical' | 'dental' | 'vision' | 'therapy' | 'vet' | 'personal_care' | 'auto' | 'home' | 'other';
export interface BookingProvider { email: string; label: string; category: ProviderCategory; appointmentTypes: string[] }
export interface AppointmentStandingConstraints extends StandingWindow {
  horizonDays: number;
  providers: BookingProvider[];
}
export interface SubscriptionCancelStandingConstraints {
  timezone: string;
  maxPerDay: number;
  allowedProviderDomains: string[];
}

export type StandingConstraints =
  | CalendarStandingConstraints
  | EmailDraftStandingConstraints
  | EmailSendStandingConstraints
  | RescheduleStandingConstraints
  | DeclineStandingConstraints
  | AppointmentStandingConstraints
  | SubscriptionCancelStandingConstraints;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ADDRESS = /^[^@\s,;<>"()]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A card-number-shaped run of 13+ digits: outgoing Autopilot text never carries it. */
export const PAYMENT_DATA = /([0-9][ -]?){13,}/;
const EMAIL_SEND_KINDS: EmailSendKind[] = ['scheduling_reply', 'follow_up', 'confirmation', 'template'];
const CATEGORIES: ProviderCategory[] = ['medical', 'dental', 'vision', 'therapy', 'vet', 'personal_care', 'auto', 'home', 'other'];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone.length > 0 && timezone.length <= 120;
  } catch {
    return false;
  }
}

const intIn = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const validWeekdays = (value: unknown) => Array.isArray(value) && value.length >= 1 && value.length <= 7
  && value.every((day) => intIn(day, 1, 7)) && new Set(value).size === value.length;
const textList = (value: unknown, min: number, max: number, maxLen: number) => Array.isArray(value) && value.length >= min && value.length <= max
  && value.every((item) => typeof item === 'string' && item.trim().length >= 1 && item.trim().length <= maxLen && !CONTROL.test(item));
const domainList = (value: unknown, min: number, max: number) => Array.isArray(value) && value.length >= min && value.length <= max
  && value.every((d) => typeof d === 'string' && d.length <= 253 && DOMAIN.test(d));
const isAddress = (value: unknown) => typeof value === 'string' && value.length <= 320 && !CONTROL.test(value) && ADDRESS.test(value.trim().toLowerCase());

const CONSTRAINT_KEYS: Record<StandingActionClass, { allowed: string[]; optional?: string[] }> = {
  'calendar.create': { allowed: ['timezone','weekdays','windowStart','windowEnd','maxDurationMinutes','maxPerDay','horizonDays','collision'] },
  'email.draft': { allowed: ['timezone','weekdays','windowStart','windowEnd','maxPerDay','allowedRecipientDomains'] },
  'email.send': { allowed: ['timezone','weekdays','windowStart','windowEnd','maxPerDay','maxPerRecipientPerDay','allowedKinds','allowedRecipients','allowedRecipientDomains','templates'] },
  'calendar.reschedule': { allowed: ['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','maxShiftDays','collision','matchTitleKeywords','maxAttendees','protectedTitleKeywords'] },
  'calendar.decline': { allowed: ['timezone','maxPerDay','horizonDays','boundaries','matchTitleKeywords','maxAttendees','protectedTitleKeywords','declineNote'], optional: ['declineNote'] },
  'appointment.book': { allowed: ['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','providers'] },
  'subscription.cancel': { allowed: ['timezone','maxPerDay','allowedProviderDomains'] },
};

/** Mirrors private.apm_autopilot_check_constraints (0033); returns the problems found. */
export function validateStandingConstraints(actionClass: StandingActionClass, input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const keys = CONSTRAINT_KEYS[actionClass];
  if (!keys) return ['unsupported_action_class'];
  for (const key of Object.keys(input)) if (!keys.allowed.includes(key)) errors.push(`unknown:${key}`);
  for (const key of keys.allowed) if (!keys.optional?.includes(key) && (input[key] === undefined || input[key] === null)) errors.push(`missing:${key}`);
  if (errors.length) return errors;

  if (typeof input.timezone !== 'string' || !validTimezone(input.timezone)) errors.push('timezone');
  const windowed = keys.allowed.includes('windowStart');
  const start = input.windowStart;
  const end = input.windowEnd;
  if (windowed) {
    if (!validWeekdays(input.weekdays)) errors.push('weekdays');
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end) || minutesOf(end) <= minutesOf(start)) errors.push('window');
  }
  const criteria = () => {
    if (!textList(input.matchTitleKeywords, 0, 10, 60)) errors.push('matchTitleKeywords');
    if (!intIn(input.maxAttendees, 0, 50)) errors.push('maxAttendees');
    if (!textList(input.protectedTitleKeywords, 0, 10, 60)) errors.push('protectedTitleKeywords');
  };

  switch (actionClass) {
    case 'calendar.create':
      if (!intIn(input.maxDurationMinutes, 15, 240)) errors.push('maxDurationMinutes');
      else if (!errors.includes('window') && (input.maxDurationMinutes as number) > minutesOf(end as string) - minutesOf(start as string)) errors.push('maxDurationMinutes');
      if (!intIn(input.maxPerDay, 1, 10)) errors.push('maxPerDay');
      if (!intIn(input.horizonDays, 1, 30)) errors.push('horizonDays');
      if (input.collision !== 'never_overlap_busy') errors.push('collision');
      break;
    case 'email.draft':
      if (!intIn(input.maxPerDay, 1, 20)) errors.push('maxPerDay');
      if (!domainList(input.allowedRecipientDomains, 1, 10)) errors.push('allowedRecipientDomains');
      break;
    case 'email.send': {
      if (!intIn(input.maxPerDay, 1, 20)) errors.push('maxPerDay');
      if (!intIn(input.maxPerRecipientPerDay, 1, 3)) errors.push('maxPerRecipientPerDay');
      const kinds = input.allowedKinds;
      if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 4 || !kinds.every((k) => EMAIL_SEND_KINDS.includes(k as EmailSendKind))) errors.push('allowedKinds');
      const recipients = input.allowedRecipients;
      if (!Array.isArray(recipients) || recipients.length > 25 || !recipients.every(isAddress)) errors.push('allowedRecipients');
      if (!domainList(input.allowedRecipientDomains, 0, 10)) errors.push('allowedRecipientDomains');
      if (Array.isArray(recipients) && Array.isArray(input.allowedRecipientDomains) && recipients.length + input.allowedRecipientDomains.length === 0) errors.push('recipients_required');
      const templates = input.templates;
      const ids = new Set<string>();
      if (!Array.isArray(templates) || templates.length > 10 || !templates.every((t) => {
        if (!t || typeof t !== 'object') return false;
        const { id, label, subject, body, ...rest } = t as Record<string, unknown>;
        const ok = Object.keys(rest).length === 0 && typeof id === 'string' && /^[a-z0-9_-]{1,40}$/.test(id) && !ids.has(id)
          && typeof label === 'string' && label.trim().length >= 1 && label.trim().length <= 80 && !CONTROL.test(label)
          && typeof subject === 'string' && subject.trim().length >= 1 && subject.trim().length <= 300 && !CONTROL.test(subject)
          && typeof body === 'string' && body.length >= 1 && body.length <= 5000;
        if (typeof id === 'string') ids.add(id);
        return ok;
      })) errors.push('templates');
      else if (templates.some((t) => PAYMENT_DATA.test(`${(t as EmailTemplate).subject} ${(t as EmailTemplate).body}`))) errors.push('payment_data');
      if (Array.isArray(kinds) && Array.isArray(templates) && kinds.includes('template') !== templates.length > 0) errors.push('templates');
      break;
    }
    case 'calendar.reschedule':
      if (!intIn(input.maxPerDay, 1, 10)) errors.push('maxPerDay');
      if (!intIn(input.horizonDays, 1, 30)) errors.push('horizonDays');
      if (!intIn(input.maxShiftDays, 0, 7)) errors.push('maxShiftDays');
      if (input.collision !== 'never_overlap_busy') errors.push('collision');
      criteria();
      break;
    case 'calendar.decline': {
      if (!intIn(input.maxPerDay, 1, 10)) errors.push('maxPerDay');
      if (!intIn(input.horizonDays, 1, 30)) errors.push('horizonDays');
      criteria();
      const boundaries = input.boundaries;
      if (!Array.isArray(boundaries) || boundaries.length < 1 || boundaries.length > 10 || !boundaries.every((b) => {
        if (!b || typeof b !== 'object') return false;
        const { weekdays, start: s, end: e, ...rest } = b as Record<string, unknown>;
        return Object.keys(rest).length === 0 && validWeekdays(weekdays) && typeof s === 'string' && typeof e === 'string'
          && HHMM.test(s) && HHMM.test(e) && minutesOf(e) > minutesOf(s);
      })) errors.push('boundaries');
      const note = input.declineNote;
      if (note !== undefined && (typeof note !== 'string' || note.trim().length < 10 || note.trim().length > 500 || CONTROL.test(note))) errors.push('declineNote');
      break;
    }
    case 'appointment.book': {
      if (!intIn(input.maxPerDay, 1, 3)) errors.push('maxPerDay');
      if (!intIn(input.horizonDays, 1, 60)) errors.push('horizonDays');
      const providers = input.providers;
      if (!Array.isArray(providers) || providers.length < 1 || providers.length > 10 || !providers.every((p) => {
        if (!p || typeof p !== 'object') return false;
        const { email, label, category, appointmentTypes, ...rest } = p as Record<string, unknown>;
        return Object.keys(rest).length === 0 && isAddress(email)
          && typeof label === 'string' && label.trim().length >= 1 && label.trim().length <= 80 && !CONTROL.test(label)
          && CATEGORIES.includes(category as ProviderCategory) && textList(appointmentTypes, 1, 5, 80);
      }) || new Set(providers.map((p) => String((p as BookingProvider).email).trim().toLowerCase())).size !== providers.length) errors.push('providers');
      break;
    }
    case 'subscription.cancel':
      if (!intIn(input.maxPerDay, 1, 5)) errors.push('maxPerDay');
      if (!domainList(input.allowedProviderDomains, 1, 10)) errors.push('allowedProviderDomains');
      break;
  }
  return errors;
}

/** Maximum standing-rule lifetime; renewal is an explicit re-grant. */
export const STANDING_RULE_MAX_DAYS = 90;

export interface LocalMoment { date: string; isoWeekday: number; minutes: number }

/** Wall-clock view of an instant in an IANA timezone. */
export function localMoment(instant: Date, timezone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(read('weekday')) + 1;
  return { date: `${read('year')}-${read('month')}-${read('day')}`, isoWeekday: weekday, minutes: Number(read('hour')) * 60 + Number(read('minute')) };
}

export type StandingProposalVerdict =
  | 'allowed'
  | 'invalid_payload'
  | 'outside_rule'
  | 'collision'
  | 'rate_limited';

export interface BusyInterval { startsAt: string; endsAt: string }

/**
 * Deterministic preview of private.apm_autopilot_claim's calendar checks
 * (duration, horizon, single local day, weekday, window, collision, daily cap).
 */
export function evaluateCalendarStandingProposal(input: {
  constraints: CalendarStandingConstraints;
  startsAt: string;
  endsAt: string;
  now: Date;
  busy: BusyInterval[];
  claimedOnLocalDay: number;
}): StandingProposalVerdict {
  const starts = Date.parse(input.startsAt);
  const ends = Date.parse(input.endsAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return 'invalid_payload';
  const c = input.constraints;
  if ((ends - starts) / 60_000 > c.maxDurationMinutes) return 'outside_rule';
  if (starts <= input.now.getTime() || starts > input.now.getTime() + c.horizonDays * 86_400_000) return 'outside_rule';
  const localStart = localMoment(new Date(starts), c.timezone);
  const localEnd = localMoment(new Date(ends), c.timezone);
  if (localStart.date !== localEnd.date) return 'outside_rule';
  if (!c.weekdays.includes(localStart.isoWeekday)) return 'outside_rule';
  if (localStart.minutes < minutesOf(c.windowStart) || localEnd.minutes > minutesOf(c.windowEnd)) return 'outside_rule';
  if (input.busy.some((event) => Date.parse(event.startsAt) < ends && Date.parse(event.endsAt) > starts)) return 'collision';
  if (input.claimedOnLocalDay >= c.maxPerDay) return 'rate_limited';
  return 'allowed';
}

export type StandingAuthorityReason =
  | AuthorityDecision['reason']
  | 'autopilot_execution_disabled'
  | 'unsupported_action_class'
  | 'class_not_activated'
  | 'autopilot_paused'
  | 'rule_inactive'
  | 'rule_expired'
  | 'class_switch_off';

/**
 * Level-5 standing authority =
 * entitlement AND permission(5) AND active unexpired rule AND activated class
 * AND master pause off AND all kill switches on. Paying for Autopilot alone is
 * never sufficient.
 */
export function decideStandingAuthority(input: {
  userId: string;
  actionClass: string;
  plan?: ProductPlan;
  planUsable: boolean;
  permission?: PermissionGrant;
  rule?: { status: 'active' | 'paused' | 'revoked'; expiresAt: string };
  classActivated: boolean;
  masterPaused: boolean;
  globalExecutionEnabled: boolean;
  domainExecutionEnabled: boolean;
  autopilotExecutionEnabled: boolean;
  /** Per-class Worker switch (AUTOPILOT_ENABLED_CLASSES). Off unless listed. */
  classSwitchEnabled: boolean;
  now: Date;
}): { allowed: boolean; reason: StandingAuthorityReason } {
  if (!isStandingActionClass(input.actionClass)) return { allowed: false, reason: 'unsupported_action_class' };
  if (!input.autopilotExecutionEnabled) return { allowed: false, reason: 'autopilot_execution_disabled' };
  if (!input.classSwitchEnabled) return { allowed: false, reason: 'class_switch_off' };
  const domain = standingActionClasses[input.actionClass].domain;
  const base = decideAuthority({
    userId: input.userId,
    domain,
    requestedLevel: 5,
    permission: input.permission,
    entitlement: input.plan && input.planUsable
      ? { domain, maxAvailableLevel: maxAutonomyForPlan(input.plan, domain), enabled: true }
      : undefined,
    globalExecutionEnabled: input.globalExecutionEnabled,
    domainExecutionEnabled: input.domainExecutionEnabled,
  });
  if (!base.allowed) return { allowed: false, reason: base.reason };
  if (input.masterPaused) return { allowed: false, reason: 'autopilot_paused' };
  if (!input.rule || input.rule.status !== 'active') return { allowed: false, reason: 'rule_inactive' };
  if (Date.parse(input.rule.expiresAt) <= input.now.getTime()) return { allowed: false, reason: 'rule_expired' };
  if (!input.classActivated) return { allowed: false, reason: 'class_not_activated' };
  return { allowed: true, reason: 'allowed' };
}
