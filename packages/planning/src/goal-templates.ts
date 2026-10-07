import type {
  ForegroundPersonaKey,
  GenericKind,
  GoalPlanContext,
  PersonaMatch,
  PlanPillar,
  PlanReasonCode,
  PlanSafety,
} from './goal-plan-types.js';

/**
 * Deterministic persona templates for the goal → plan engine.
 *
 * Safety rules (docs: app-only Tracks Body Foundation / Wealth Foundation / Home Front):
 * - weight loss is behavioural only: pace ≤1% bodyweight/week and ≤2 lb/week, no diet,
 *   calorie, supplement or medication prescriptions, a doctor line for red flags;
 * - wealth is behavioural only: no securities, crypto, tax, insurance or allocation advice;
 * - parent+ keeps a non-zero family floor every day.
 */

export interface ActionSpec {
  key: string;
  /** May contain `{m}`, replaced by the final (availability-capped) minutes. */
  title: string;
  output: string;
  minutes: number;
  pillar: PlanPillar;
  mvd: [title: string, output: string, minutes: number];
  satisfies?: string[];
}

export interface GateSpec {
  outcome: string;
  milestones: Array<[day: number, title: string]>;
  /** Action keys Sunday → Saturday. */
  week: [string, string, string, string, string, string, string];
}

export interface TemplateSpec {
  key: string;
  pillar: PlanPillar;
  label: string;
  actions: ActionSpec[];
  setup: string[];
  floors: string[];
  gates: [GateSpec, GateSpec, GateSpec];
  decisionCriteria: string[];
  safety: PlanSafety;
}

// ---------------------------------------------------------------------------
// Safety vocabularies (used by validatePlan).
// ---------------------------------------------------------------------------

/** Diet / medication prescription language that no plan action may contain. */
export const BODY_PRESCRIPTION_PATTERN =
  /\b(calories?|kcal|diet|dieting|keto|paleo|fasting|fast for|intermittent|carbs?|macros?|supplements?|medications?|pills?|ozempic|wegovy|mounjaro|zepbound|glp-?1|semaglutide|tirzepatide|detox|cleanse|appetite suppressant)\b/i;

/** Shame / appearance language Body Foundation forbids. */
export const BODY_SHAME_PATTERN = /(earn your food|before\/after|before and after|bikini body|beach body|burn it off|cheat meal)/i;

/** Securities / product advice that no plan action may contain. */
export const SECURITIES_PATTERN =
  /\b(stocks?|etfs?|crypto|cryptocurrenc\w*|bitcoin|ethereum|index funds?|mutual funds?|s&p|bonds?|options trading|day[- ]trad\w*|shares|nasdaq|reits?|annuit\w*|forex|tickers?|whole life|term life)\b/i;

export const DOCTOR_LINE =
  'If you have chest pain, fainting, signs of disordered eating, pregnancy or a diagnosed condition, stop and talk to a doctor before continuing. A clinician owns diet and medication decisions.';

const TRAINING_DOCTOR_LINE =
  'If you have chest pain, fainting or an injury that changes how you move, stop training and talk to a doctor.';

const RED_FLAG_PATTERNS: RegExp[] = [
  /chest pain/i,
  /faint(ed|ing)?\b/i,
  /pass(ed)? out/i,
  /purg(e|ed|ing)/i,
  /eating disorder/i,
  /anorexi/i,
  /bulimi/i,
  /binge/i,
  /pregnan/i,
  /diagnos(ed|is)/i,
  /\bfast(ing)? (for )?(\d+|several|a few|multiple) days\b/i,
  /\b(48|72|96)[- ]?h(ou)?r? fast/i,
];

/** Red-flag scan over goal text and health notes (Body Foundation `body.referral`). */
export function bodyRedFlags(texts: string[]): string[] {
  const hits: string[] = [];
  for (const text of texts) {
    for (const pattern of RED_FLAG_PATTERNS) {
      const match = text.match(pattern);
      if (match) hits.push(match[0].toLowerCase());
    }
    for (const match of text.matchAll(/(\d{3,4})\s*(kcal|cal\b|calories)/gi)) {
      if (Number(match[1]) < 1200) hits.push(match[0].toLowerCase());
    }
  }
  return [...new Set(hits)];
}

// ---------------------------------------------------------------------------
// Persona recognition
// ---------------------------------------------------------------------------

const PERSONA_PATTERNS: Array<{ key: ForegroundPersonaKey; pattern: RegExp }> = [
  {
    key: 'weight_loss',
    pattern:
      /\b(lose|drop|shed|losing|dropping)\b[^.]{0,20}\b(\d+\s*(lbs?|pounds|kg|kilos?|kilograms)|weight)\b|\bweight[- ]loss\b|\blose weight\b|\bfat loss\b|\bget (back )?in shape\b|\bget healthy\b/i,
  },
  {
    key: 'wealth_building',
    pattern:
      /\b(emergency fund|net worth|pay off|payoff|debt[- ]free|out of debt|credit card debt|student loans?|save \$?\d|save (money|more)|savings|build wealth|wealth|financial(ly)? (freedom|independen\w*)|retire(ment)?|invest(ing)?)\b/i,
  },
  {
    key: 'operator_promotion',
    pattern:
      /\b(promot(ed|ion)|get to (senior|staff|principal|director|vp|manager)|next level at work|move up|level up at work|(senior|staff|principal|director|vp|head of)\b.{0,15}\b(role|title|level|by)|raise at work|performance review)\b/i,
  },
  {
    key: 'founder',
    pattern:
      /\b(customers?|revenue|mrr|arr|startup|start-up|my (business|company|agency|product|app)|first \d+ (clients|customers|users)|paying (clients|customers|users)|clients|sales|founder|pre-?seed|seed round|fundrais\w*|launch (my|the|a) (business|company|product|app|startup))\b/i,
  },
];

const ROLE_HINTS: Array<{ key: ForegroundPersonaKey; pattern: RegExp }> = [
  { key: 'founder', pattern: /(founder|entrepreneur|business|startup)/i },
  { key: 'operator_promotion', pattern: /(career|professional|leader|manager|operator)/i },
  { key: 'weight_loss', pattern: /(health|rebuilding)/i },
];

const PARENT_ROLE = /(parent|caregiv|mom|mum|dad|father|mother|guardian)/i;
const PARENT_GOAL = /\b(kids?|children|my (son|daughter|baby|family)|family time|while (parenting|raising))\b/i;

const GENERIC_PATTERNS: Array<{ kind: GenericKind; pattern: RegExp }> = [
  {
    kind: 'race',
    pattern: /\b(marathon|half[- ]marathon|5k|10k|half ironman|ironman|triathlon|ultra|race|run a|sprint distance|cycling event|gran fondo)\b/i,
  },
  {
    kind: 'exam',
    pattern: /\b(exam|bar exam|cpa|mcat|lsat|gre|gmat|sat|act|usmle|nclex|boards|certification|certified|pass (the|my)|finals|test)\b/i,
  },
  {
    kind: 'creative_release',
    pattern: /\b(album|ep|mixtape|single|novel|book|memoir|screenplay|short film|film|documentary|podcast|collection|portfolio|gallery show|release|publish|record)\b/i,
  },
];

export function genericKindFor(goalText: string): GenericKind {
  return GENERIC_PATTERNS.find(({ pattern }) => pattern.test(goalText))?.kind ?? 'other';
}

/** Recognise the persona from free text first, then roles; parent+ wraps a second game. */
export function recognizePersona(goalText: string, roles: string[] = []): PersonaMatch {
  const matchedBy: string[] = [];
  let foreground: ForegroundPersonaKey | undefined;
  for (const { key, pattern } of PERSONA_PATTERNS) {
    const match = goalText.match(pattern);
    if (match) {
      foreground = key;
      matchedBy.push(`goal:${match[0].trim().toLowerCase()}`);
      break;
    }
  }
  let genericKind: GenericKind | undefined;
  if (!foreground) {
    genericKind = genericKindFor(goalText);
    if (genericKind === 'other') {
      const roleHit = ROLE_HINTS.find(({ pattern }) => roles.some((role) => pattern.test(role)));
      // Roles only break ties for open-ended business/career goals; they never turn
      // "run a marathon" into a founder plan.
      if (roleHit && roleHit.key !== 'weight_loss' && /\b(grow|build|scale|win|career|work|job|business)\b/i.test(goalText)) {
        foreground = roleHit.key;
        genericKind = undefined;
        matchedBy.push(`role:${roleHit.key}`);
      }
    }
    if (!foreground) {
      foreground = 'generic';
      matchedBy.push(`generic:${genericKind}`);
    }
  }
  const parentRole = roles.find((role) => PARENT_ROLE.test(role));
  const parentGoal = goalText.match(PARENT_GOAL);
  if (parentRole || parentGoal) {
    matchedBy.push(parentRole ? `role:${parentRole.toLowerCase()}` : `goal:${parentGoal![0].toLowerCase()}`);
    return { key: 'parent_plus', foregroundPersona: foreground, genericKind, matchedBy };
  }
  return { key: foreground, foregroundPersona: foreground, genericKind, matchedBy };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`).getTime();
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / 86_400_000,
  );
}

function shortGoal(goalText: string): string {
  const trimmed = goalText.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57).trimEnd()}...` : trimmed;
}

function emptySafety(): PlanSafety {
  return { reasonCodes: [], notes: [], referral: false };
}

const scoreWeek = (key: string, what: string, pillar: PlanPillar): ActionSpec => ({
  key,
  title: `Score the week: ${what}`,
  output: 'The week\'s numbers written in one line of your log',
  minutes: 15,
  pillar,
  mvd: ['Write one line: what moved this week and the next physical step', 'One-line weekly note saved', 5],
});

// ---------------------------------------------------------------------------
// Weight loss (Body Foundation rules; behaviour only)
// ---------------------------------------------------------------------------

interface WeightTarget {
  amount: number;
  unit: 'lb' | 'kg';
}

export function parseWeightTarget(goalText: string): WeightTarget | undefined {
  const match = goalText.match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds|kg|kilos?|kilograms)\b/i);
  if (!match) return undefined;
  const unit = /^(kg|kilo)/i.test(match[2] ?? '') ? 'kg' : 'lb';
  return { amount: Number(match[1]), unit };
}

const KG_PER_LB = 0.45359237;

/** Weekly ceiling: min(1% bodyweight, 2 lb / 0.9 kg). Unknown bodyweight → 1 lb (0.45 kg). */
export function weeklyRateCeiling(unit: 'lb' | 'kg', currentWeight?: number, weightUnit?: 'lb' | 'kg'): number {
  const capLb = 2;
  let ceilingLb: number;
  if (currentWeight && currentWeight > 0) {
    const weightLb = (weightUnit ?? unit) === 'kg' ? currentWeight / KG_PER_LB : currentWeight;
    ceilingLb = Math.min(weightLb * 0.01, capLb);
  } else {
    ceilingLb = 1;
  }
  const value = unit === 'kg' ? Math.min(ceilingLb * KG_PER_LB, 0.9) : ceilingLb;
  return Math.round(value * 100) / 100;
}

function weightLossSafety(goalText: string, context: GoalPlanContext): PlanSafety {
  const safety = emptySafety();
  safety.doctorLine = DOCTOR_LINE;
  safety.reasonCodes.push('body.no_prescription');
  safety.notes.push('Behaviour only: no diet plans, calorie numbers, supplements or medication. Those belong to your clinician.');
  const flags = bodyRedFlags([goalText, ...(context.body?.healthNotes ?? []), ...(context.constraints ?? [])]);
  if ((flags.length > 0 || context.body?.referralActive) && !context.body?.clinicianCleared) {
    safety.referral = true;
    safety.reasonCodes.push('body.referral');
    safety.notes.push(flags.length
      ? `Red flag noted (${flags.join(', ')}). Body coaching is paused until a clinician clears you.`
      : 'A red flag was recorded earlier. Body coaching stays paused until you record clinician clearance.');
  }
  const target = parseWeightTarget(goalText);
  if (target) {
    const ceiling = weeklyRateCeiling(target.unit, context.body?.currentWeight, context.body?.unit);
    safety.weeklyRateCeiling = { amount: ceiling, unit: target.unit };
    const safeWeeks = Math.ceil(target.amount / ceiling);
    safety.safePaceDate = addDays(context.startDate, safeWeeks * 7);
    if (!context.body?.currentWeight) {
      safety.reasonCodes.push('body.pace_unverified');
      safety.notes.push(
        `Pace set to ${ceiling} ${target.unit}/week until you add your current weight (the ceiling is 1% of bodyweight a week, never more than 2 lb).`,
      );
    }
    if (context.targetDate) {
      const weeks = Math.max(daysBetween(context.startDate, context.targetDate) / 7, 0.01);
      const required = target.amount / weeks;
      if (required > ceiling && !context.body?.clinicianSupervised) {
        safety.reasonCodes.push('body.rate_ceiling');
        safety.notes.push(
          `${target.amount} ${target.unit} by ${context.targetDate} needs ${required.toFixed(1)} ${target.unit}/week, above the safe ceiling of ${ceiling}. The plan uses the safe-pace date ${safety.safePaceDate} unless a clinician supervises a faster pace.`,
        );
      }
    }
  }
  return safety;
}

function weightLossTemplate(goalText: string, context: GoalPlanContext): TemplateSpec {
  const safety = weightLossSafety(goalText, context);
  const target = parseWeightTarget(goalText);
  const floor = 'movement_floor';
  const walk = (key: string, minutes: number, where = 'at your fixed movement time'): ActionSpec => ({
    key,
    title: `Walk {m} minutes ${where}`,
    output: 'Walk logged with its minutes',
    minutes,
    pillar: 'body',
    mvd: ['Walk 10 minutes', '10-minute walk logged', 10],
    satisfies: [floor],
  });

  if (safety.referral) {
    const book: ActionSpec = {
      key: 'book_clinician',
      title: 'Call your doctor\'s office and book an appointment about your health goal',
      output: 'Appointment date and time written in your calendar',
      minutes: 10,
      pillar: 'body',
      mvd: ['Write the clinic\'s phone number and the time you will call', 'Number and call time saved in one note', 3],
    };
    const confirm: ActionSpec = {
      key: 'confirm_clinician',
      title: 'Confirm your doctor appointment is booked, or call to book it',
      output: 'Appointment date visible in your calendar',
      minutes: 5,
      pillar: 'body',
      mvd: ['Check your calendar for the appointment date', 'Appointment date confirmed', 2],
    };
    const week = Array(7).fill(confirm.key) as GateSpec['week'];
    const gate = (outcome: string, day: number, title: string): GateSpec => ({ outcome, milestones: [[day, title]], week });
    return {
      key: 'weight_loss.referral',
      pillar: 'body',
      label: 'See a clinician before body coaching',
      actions: [book, confirm],
      setup: [book.key],
      floors: [],
      gates: [
        gate('A clinician has reviewed your health goal and red flag.', 14, 'Appointment attended'),
        gate('Clinician guidance recorded; body coaching resumes only after clearance.', 45, 'Clearance or clinician plan noted'),
        gate('Clinician-led plan in place.', 75, 'Follow-up booked if your clinician asked for one'),
      ],
      decisionCriteria: ['Clinician clearance recorded', 'Still aligned with what your clinician advised'],
      safety,
    };
  }

  const weighIn = context.body?.weighInCadence ?? 'weekly';
  const actions: ActionSpec[] = [
    {
      key: 'setup_slot',
      title: 'Pick a fixed daily movement time, put it in your calendar as a repeating event, and walk 10 minutes now',
      output: 'Repeating calendar slot saved and first 10-minute walk logged',
      minutes: 15,
      pillar: 'body',
      mvd: ['Walk 10 minutes', '10-minute walk logged', 10],
      satisfies: [floor],
    },
    {
      key: 'setup_cadence',
      title:
        weighIn === 'weekly'
          ? 'Weigh in once after waking, log the start number, and set a weekly Sunday reminder'
          : 'Write your three tracked behaviours (movement, planned meals, sleep window) at the top of your log',
      output: weighIn === 'weekly' ? 'Start number logged and weekly reminder set' : 'Three behaviours written in your log',
      minutes: 5,
      pillar: 'body',
      mvd: ['Write "movement, meals, sleep" at the top of your log', 'Behaviour list saved', 2],
    },
    {
      key: 'setup_sleep',
      title: 'Write your target sleep window and set a phone alarm 30 minutes before lights-out',
      output: 'Sleep window written and wind-down alarm set',
      minutes: 5,
      pillar: 'body',
      mvd: ['Set tonight\'s wind-down alarm', 'Alarm set', 2],
    },
    walk('walk', 20),
    walk('walk_long', 30, 'outdoors, or bike the same time'),
    {
      key: 'meal_list',
      title: 'Write the next 3 days of meals on one list and buy what is missing',
      output: 'Written 3-day meal list and groceries bought',
      minutes: 30,
      pillar: 'body',
      mvd: ['Write tomorrow\'s meals on one note', 'Tomorrow\'s meals written', 5],
    },
    {
      key: 'sleep_window',
      title: 'Start your wind-down at the alarm and be in bed by your lights-out time tonight',
      output: 'Bedtime logged against your sleep window',
      minutes: 10,
      pillar: 'body',
      mvd: ['Set tonight\'s wind-down alarm', 'Alarm set', 2],
    },
    {
      key: 'environment',
      title: 'Move one trigger snack out of sight and put a filled water bottle where you work',
      output: 'One trigger item moved and water bottle in place',
      minutes: 10,
      pillar: 'body',
      mvd: ['Fill a water bottle and put it where you work', 'Water bottle in place', 2],
    },
    {
      key: 'weekly_score',
      title:
        weighIn === 'weekly'
          ? 'Weigh in once after waking and log it beside this week\'s movement days (x/7)'
          : 'Log this week\'s movement days (x/7), planned-meal days and sleep-window nights',
      output: 'Weekly behaviour count logged',
      minutes: 5,
      pillar: 'body',
      mvd: ['Log how many days you moved this week', 'Movement count logged', 2],
    },
    {
      key: 'strength',
      title: 'Do {m} minutes of bodyweight strength: squats to a chair, wall push-ups, step-ups',
      output: 'Strength session logged with its minutes',
      minutes: 15,
      pillar: 'body',
      mvd: ['Do 10 squats to a chair and walk 10 minutes', 'Squats and walk logged', 12],
      satisfies: [floor],
    },
    {
      key: 'batch_prep',
      title: 'Cook two lunches ahead and portion them into containers',
      output: 'Two lunches in the fridge',
      minutes: 45,
      pillar: 'body',
      mvd: ['Write tomorrow\'s meals on one note', 'Tomorrow\'s meals written', 5],
    },
    {
      key: 'default_breakfast',
      title: 'Write one default breakfast you can repeat on busy days and buy what it needs',
      output: 'Default breakfast written and ingredients in the kitchen',
      minutes: 20,
      pillar: 'body',
      mvd: ['Write one default breakfast on your list', 'Default breakfast written', 3],
    },
    {
      key: 'slip_plan',
      title: 'Write your if-then slip plan: "If I slip, my next planned meal or walk is the recovery"',
      output: 'If-then slip plan saved where you will see it',
      minutes: 10,
      pillar: 'body',
      mvd: ['Write one if-then line for your most common slip', 'If-then line saved', 3],
    },
    {
      key: 'social_plan',
      title: 'Put one walk with a friend or family member in the calendar this week and send the invite',
      output: 'Invite sent for a shared walk',
      minutes: 10,
      pillar: 'body',
      mvd: ['Send one message inviting someone on a walk', 'Invite sent', 3],
    },
    {
      key: 'movement_floor',
      title: 'Walk {m} minutes (movement floor)',
      output: 'Movement floor logged',
      minutes: 10,
      pillar: 'body',
      mvd: ['Walk 10 minutes', '10-minute walk logged', 10],
      satisfies: [floor],
    },
  ];
  const paceLine = target && safety.weeklyRateCeiling
    ? ` Any change in weight is lagging data, at most ${Math.min(
        target.amount,
        Math.round(safety.weeklyRateCeiling.amount * (90 / 7) * 10) / 10,
      )} ${target.unit} over 90 days at the safe pace (${target.amount} ${target.unit} by ${safety.safePaceDate} at the earliest).`
    : '';
  return {
    key: 'weight_loss',
    pillar: 'body',
    label: 'Body: become a person who takes care of their body',
    actions,
    setup: ['setup_slot', 'setup_cadence', 'setup_sleep'],
    floors: [floor],
    gates: [
      {
        outcome:
          'Foundation: movement on 24 of 30 days, meals planned weekly, a fixed sleep window, and the weigh-in cadence you chose. The behaviours are the scoreboard.',
        milestones: [
          [7, 'Movement slot fixed and used on 5 of 7 days'],
          [14, 'First 3-day meal list written and shopped'],
          [30, 'Sleep window held on 5 nights a week'],
        ],
        week: ['weekly_score', 'walk', 'meal_list', 'walk', 'sleep_window', 'environment', 'walk_long'],
      },
      {
        outcome: 'Build: two strength sessions a week added and lunches prepared ahead, without missing twice in a row.',
        milestones: [
          [40, 'Two strength sessions done in one week'],
          [50, 'Lunches prepared ahead for two straight weeks'],
          [60, 'No two-day gap in movement this gate'],
        ],
        week: ['weekly_score', 'walk', 'strength', 'batch_prep', 'walk', 'strength', 'walk_long'],
      },
      {
        outcome: `Establish: the routine runs on busy weeks: default breakfast, a written slip plan, and movement you could keep for 12 months.${paceLine}`,
        milestones: [
          [70, 'Default breakfast in use on busy days'],
          [80, 'Slip plan used at least once and the next action kept'],
          [90, 'Movement on 80% of days this gate'],
        ],
        week: ['weekly_score', 'walk', 'strength', 'default_breakfast', 'slip_plan', 'strength', 'social_plan'],
      },
    ],
    decisionCriteria: [
      'Movement days per week across the 90 days (the behaviour, not the number on the scale)',
      'Could you keep this routine for 12 months?',
      'Still aligned with what your clinician advised, if you see one',
    ],
    safety,
  };
}

// ---------------------------------------------------------------------------
// Wealth building (Wealth Foundation rules; no securities or product advice)
// ---------------------------------------------------------------------------

const SPECULATION = /\b(crypto|bitcoin|stocks?|options|day[- ]trad\w*|forex|nft|meme|get rich|10x|moonshot)\b/i;

function wealthTemplate(goalText: string): TemplateSpec {
  const safety = emptySafety();
  safety.reasonCodes.push('wealth.no_product_advice');
  safety.notes.push('Behaviour only: no securities, crypto, tax, insurance or allocation advice. Those belong to a licensed professional.');
  if (SPECULATION.test(goalText)) {
    safety.reasonCodes.push('wealth.buffer_gate');
    safety.notes.push('Speculative moves stay flagged until your emergency buffer target is met and high-interest debt is cleared.');
  }
  const p: PlanPillar = 'wealth';
  const actions: ActionSpec[] = [
    {
      key: 'setup_debts',
      title: 'List every debt in one sheet with balance, interest rate and minimum payment',
      output: 'Debt sheet saved with every account on it',
      minutes: 30,
      pillar: p,
      mvd: ['Write the name and balance of your highest-rate debt', 'One debt written down', 5],
    },
    {
      key: 'setup_order',
      title: 'Number your debts in payoff order (highest interest rate first unless you choose otherwise) and write the reason',
      output: 'Numbered payoff order saved in the debt sheet',
      minutes: 15,
      pillar: p,
      mvd: ['Write which debt is #1 in your payoff order', 'Debt #1 named', 3],
    },
    {
      key: 'setup_buffer',
      title: 'Write your starter emergency-fund target (for example one month of essentials) and open or label a separate savings account for it',
      output: 'Target amount written and savings account labelled',
      minutes: 20,
      pillar: p,
      mvd: ['Write your starter emergency-fund target amount', 'Target amount written', 3],
    },
    {
      key: 'buffer_transfer',
      title: 'Transfer your chosen weekly amount to the emergency fund and log the new balance',
      output: 'Transfer done and balance logged',
      minutes: 10,
      pillar: p,
      mvd: ['Log your emergency-fund balance', 'Balance logged', 2],
    },
    {
      key: 'debt_payment',
      title: 'Make this week\'s extra payment on debt #1 and save the confirmation',
      output: 'Payment confirmation for debt #1 saved',
      minutes: 10,
      pillar: p,
      mvd: ['Check debt #1\'s balance and log it', 'Debt #1 balance logged', 3],
    },
    {
      key: 'income_move',
      title: 'Send one message that grows income: a raise conversation request, a rate increase, or a pitch to a paying client',
      output: 'One sent message about pay or new paid work',
      minutes: 25,
      pillar: p,
      mvd: ['Write one income-growth move in your money note', 'Income move written', 5],
    },
    {
      key: 'leak_check',
      title: 'Cancel or downgrade one recurring charge from last month\'s statement, or write why it stays',
      output: 'One charge cancelled, downgraded or kept with a written reason',
      minutes: 15,
      pillar: p,
      mvd: ['Highlight one recurring charge on your statement', 'One charge highlighted', 5],
    },
    {
      key: 'automation',
      title: 'Set or confirm the automatic payday transfer to savings: amount, account and date',
      output: 'Automatic transfer scheduled and screenshot saved',
      minutes: 15,
      pillar: p,
      mvd: ['Open your bank app and confirm the next transfer date', 'Transfer date confirmed', 3],
    },
    {
      key: 'spend_log',
      title: 'Add up this week\'s spending from your bank app and write the total in your money sheet',
      output: 'Weekly spending total logged',
      minutes: 15,
      pillar: p,
      mvd: ['Write this week\'s largest purchase in your money sheet', 'One purchase logged', 3],
    },
    scoreWeek('weekly_score', 'emergency-fund balance, debt #1 balance, automatic transfers made', p),
    {
      key: 'auto_invest',
      title: 'Schedule an automatic monthly contribution on payday to your retirement or long-term account and save the confirmation',
      output: 'Recurring contribution scheduled with its date',
      minutes: 20,
      pillar: p,
      mvd: ['Log whether this month\'s automatic contribution ran', 'Contribution status logged', 2],
    },
    {
      key: 'employer_match',
      title: 'Email HR or check the benefits portal for the employer retirement match rule and write it down',
      output: 'Match rule written in your money sheet',
      minutes: 15,
      pillar: p,
      mvd: ['Write one question about your benefits to send HR', 'Question written', 3],
    },
    {
      key: 'income_ask',
      title: 'Book the pay or rate conversation: send the meeting request with the date you want',
      output: 'Meeting request sent',
      minutes: 15,
      pillar: p,
      mvd: ['Write the one number you will ask for', 'Number written', 3],
    },
    {
      key: 'raise_rule',
      title: 'Write your raise-with-raises rule: the share of any future pay increase that goes to savings or debt',
      output: 'Percentage rule saved in your money sheet',
      minutes: 10,
      pillar: p,
      mvd: ['Write the percentage you will route from your next raise', 'Percentage written', 2],
    },
    {
      key: 'advisor_questions',
      title: 'Write three questions for a licensed fee-only adviser about your long-term account choices',
      output: 'Three adviser questions saved',
      minutes: 15,
      pillar: p,
      mvd: ['Write one question for a licensed adviser', 'Question saved', 3],
    },
  ];
  return {
    key: 'wealth_building',
    pillar: p,
    label: 'Wealth: save by default, one debt at a time',
    actions,
    setup: ['setup_debts', 'setup_order', 'setup_buffer'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: every debt listed in a payoff order, a starter emergency-fund target set, and an automatic payday transfer running.',
        milestones: [
          [3, 'Debt sheet and payoff order written'],
          [14, 'Automatic payday transfer scheduled'],
          [30, 'Four weekly emergency-fund transfers made'],
        ],
        week: ['weekly_score', 'buffer_transfer', 'debt_payment', 'income_move', 'leak_check', 'automation', 'spend_log'],
      },
      {
        outcome: 'Build: the emergency fund grows every week, debt #1 shrinks every week, and an automatic monthly long-term contribution is scheduled.',
        milestones: [
          [40, 'Employer match rule known and captured if offered'],
          [50, 'Automatic monthly long-term contribution scheduled'],
          [60, 'Debt #1 balance lower than on day 30'],
        ],
        week: ['weekly_score', 'buffer_transfer', 'debt_payment', 'auto_invest', 'employer_match', 'income_ask', 'leak_check'],
      },
      {
        outcome: 'Establish: savings and debt payments run without willpower, the raise-with-raises rule is written, and one income-growth conversation is done.',
        milestones: [
          [70, 'Income conversation held or booked'],
          [80, 'Raise-with-raises rule written'],
          [90, 'Twelve weeks of automatic transfers on record'],
        ],
        week: ['weekly_score', 'buffer_transfer', 'debt_payment', 'raise_rule', 'leak_check', 'income_move', 'advisor_questions'],
      },
    ],
    decisionCriteria: [
      'Automatic transfers that ran (x/12 weeks)',
      'Emergency-fund balance against your target',
      'Debt #1 balance trend, and whether any account closed',
    ],
    safety,
  };
}

// ---------------------------------------------------------------------------
// Founder / entrepreneur (customer and revenue foreground)
// ---------------------------------------------------------------------------

const DECISIVE_FOLLOW_UP: ActionSpec['mvd'] = [
  'Send one decisive follow-up to your warmest open lead asking for a yes, a no or a meeting date',
  'One follow-up sent with a clear ask',
  5,
];

function founderTemplate(): TemplateSpec {
  const p: PlanPillar = 'execution';
  const a = (key: string, title: string, output: string, minutes: number): ActionSpec => ({
    key,
    title,
    output,
    minutes,
    pillar: p,
    mvd: DECISIVE_FOLLOW_UP,
  });
  return {
    key: 'founder',
    pillar: p,
    label: 'Customers and revenue',
    actions: [
      a('setup_list', 'Write the list of 30 people or companies who fit your customer profile, with how you will reach each', '30-name customer list saved', 45),
      a('setup_offer', 'Write your offer in three lines: who it is for, the result, and the price', 'Three-line offer with a price saved', 20),
      a('outreach', 'Spend {m} minutes sending personalised outreach messages to people on your customer list', 'Sent messages logged by name', 30),
      a('conversation', 'Hold or book one customer conversation and write three lines of notes', 'Conversation held or booked, with notes', 45),
      a('offer_sent', 'Send a written offer with a price to one qualified prospect', 'One priced offer sent', 30),
      a('follow_ups', 'Follow up every open conversation from this week with one clear ask', 'Every open thread has a dated follow-up', 30),
      a('pipeline', 'Update the pipeline: name, stage, next step and date for every open lead', 'Pipeline sheet current for every lead', 20),
      a('objection', 'Write one page answering the most common objection you heard this week', 'One-page objection answer saved', 30),
      a('weekly_score', 'Score the week: conversations held, offers sent, revenue committed', 'Three numbers logged', 15),
      a('referral_ask', 'Ask one happy customer or warm contact for two introductions by name', 'Introduction request sent', 15),
      a('case_study', 'Write a one-page case study from your best customer result with their numbers', 'Case study draft saved', 45),
      a('channel_test', 'Run one repeatable outreach batch from your best channel and log replies', 'Batch sent and reply count logged', 45),
      a('standard_offer', 'Write the standard offer and price you will use for every new customer next month', 'Standard offer page saved', 30),
      a('renewal', 'Ask one current customer to renew, expand or commit to the next month in writing', 'Renewal or expansion ask sent', 15),
      a('playbook', 'Write the sales steps that worked, as a numbered checklist someone else could follow', 'Numbered sales checklist saved', 30),
    ],
    setup: ['setup_list', 'setup_offer'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: prove the concept with 10 customer conversations and the first paid commitment, or a clear no that redirects the offer.',
        milestones: [
          [7, '30-name customer list and three-line offer written'],
          [20, '10 customer conversations held'],
          [30, 'First paid commitment, or a written reason the offer changes'],
        ],
        week: ['weekly_score', 'outreach', 'conversation', 'offer_sent', 'follow_ups', 'pipeline', 'objection'],
      },
      {
        outcome: 'Build: create the leverage with one repeatable channel, referrals and a case study that sells for you.',
        milestones: [
          [40, 'One channel producing replies every week'],
          [50, 'Case study written from a real customer result'],
          [60, 'Three paying customers, or revenue at your 60-day number'],
        ],
        week: ['weekly_score', 'channel_test', 'conversation', 'offer_sent', 'referral_ask', 'pipeline', 'case_study'],
      },
      {
        outcome: 'Establish: lock the asset with a standard offer, recurring or repeat revenue, and a written sales checklist.',
        milestones: [
          [70, 'Standard offer and price in use'],
          [80, 'At least one renewal, expansion or repeat purchase'],
          [90, 'Sales checklist written and used'],
        ],
        week: ['weekly_score', 'channel_test', 'conversation', 'renewal', 'follow_ups', 'standard_offer', 'playbook'],
      },
    ],
    decisionCriteria: [
      'Revenue committed in 90 days',
      'Conversations held and offer-to-yes rate',
      'Whether one channel produces customers without you inventing it each week',
    ],
    safety: emptySafety(),
  };
}

// ---------------------------------------------------------------------------
// Operator moving up (promotion deliverable, visibility, manager 1:1s)
// ---------------------------------------------------------------------------

function operatorTemplate(): TemplateSpec {
  const p: PlanPillar = 'execution';
  const mvd: ActionSpec['mvd'] = [
    'Finish one concrete step of the promotion deliverable (one slide, one paragraph or one query) and save it',
    'One saved step in the deliverable file',
    15,
  ];
  const a = (key: string, title: string, output: string, minutes: number, m: ActionSpec['mvd'] = mvd): ActionSpec => ({
    key,
    title,
    output,
    minutes,
    pillar: p,
    mvd: m,
  });
  const update: ActionSpec['mvd'] = ['Send your manager a two-line progress note', 'Progress note sent', 5];
  return {
    key: 'operator_promotion',
    pillar: p,
    label: 'The deliverable that earns the promotion',
    actions: [
      a('setup_criteria', 'Write the next level\'s criteria in three bullets and the one deliverable that proves them', 'Criteria and deliverable written in one doc', 20),
      a('setup_ask', 'Add this to your next manager 1:1 agenda: "What would make the case for the next level undeniable by our next review?"', 'Agenda item sent to your manager', 10, update),
      a('deliverable', 'Block {m} minutes and produce the next section of the promotion deliverable', 'One section saved in the deliverable file', 90),
      a('visibility', 'Send a three-line progress update on the deliverable to your manager and one stakeholder', 'Update sent to two people', 15, update),
      a('one_on_one', 'Write your manager 1:1 agenda: wins, one blocker, one ask', 'Agenda sent before the 1:1', 15, update),
      a('share_result', 'Post one result in the team channel with the number it moved', 'One result posted with a number', 15, update),
      a('brag_doc', 'Write this week\'s three wins with their impact in your promotion log', 'Three dated wins in the log', 10, ['Write one win and its impact in your promotion log', 'One dated win logged', 3]),
      a('weekly_score', 'Score the week: deliverable sections done, updates sent, 1:1 held', 'Three numbers logged', 15),
      a('sponsor_ask', 'Ask one senior leader for 20 minutes of feedback on the deliverable and send the invite', 'Invite sent to a senior leader', 15, update),
      a('feedback_apply', 'Apply the latest feedback to the deliverable and note what changed', 'Revised section saved with a change note', 45),
      a('present', 'Book a slot to present the deliverable to your manager and the stakeholder who cares most', 'Presentation slot in the calendar', 15, update),
      a('promotion_ask', 'In your 1:1, ask directly what stands between you and the next level and the timeline, and write the answer', 'Answer written in your promotion log', 30, update),
      a('handoff', 'Write a one-page handoff of your current duties so someone else could run them', 'Handoff page saved', 45),
    ],
    setup: ['setup_criteria', 'setup_ask'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: the promotion deliverable is agreed with your manager and its first milestone is shipped.',
        milestones: [
          [3, 'Criteria and deliverable written'],
          [14, 'Manager agrees the deliverable proves the next level'],
          [30, 'First milestone of the deliverable shipped'],
        ],
        week: ['weekly_score', 'deliverable', 'visibility', 'deliverable', 'one_on_one', 'share_result', 'brag_doc'],
      },
      {
        outcome: 'Build: visibility beyond your manager, with one senior sponsor who has seen the work and given feedback.',
        milestones: [
          [40, 'Senior leader feedback session held'],
          [50, 'Feedback applied to the deliverable'],
          [60, 'Deliverable 80% complete'],
        ],
        week: ['weekly_score', 'deliverable', 'sponsor_ask', 'feedback_apply', 'one_on_one', 'share_result', 'brag_doc'],
      },
      {
        outcome: 'Establish: the deliverable is presented, the promotion question is asked directly, and your current duties have a handoff.',
        milestones: [
          [70, 'Deliverable presented'],
          [80, 'Promotion timeline asked and written down'],
          [90, 'Handoff page written'],
        ],
        week: ['weekly_score', 'deliverable', 'present', 'promotion_ask', 'one_on_one', 'handoff', 'brag_doc'],
      },
    ],
    decisionCriteria: [
      'Deliverable shipped and seen by your manager and a senior sponsor',
      'A stated promotion timeline, or a clear reason there is none',
      'Still the role you want',
    ],
    safety: emptySafety(),
  };
}

// ---------------------------------------------------------------------------
// Generic fallback: race, exam, creative release, anything else
// ---------------------------------------------------------------------------

function raceTemplate(): TemplateSpec {
  const p: PlanPillar = 'body';
  const easy: ActionSpec['mvd'] = ['Walk or jog 10 minutes easy', '10 minutes logged', 10];
  const a = (key: string, title: string, output: string, minutes: number, m = easy): ActionSpec => ({ key, title, output, minutes, pillar: p, mvd: m });
  const safety = emptySafety();
  safety.doctorLine = TRAINING_DOCTOR_LINE;
  return {
    key: 'generic.race',
    pillar: p,
    label: 'Race preparation',
    actions: [
      a('setup_race', 'Write the race date and distance, register if you have not, and put four weekly run slots in your calendar', 'Registration confirmed and four run slots saved', 20, ['Write the race date and distance in your log', 'Race date written', 3]),
      a('easy_run', 'Run {m} minutes at an easy, conversational pace', 'Run logged with minutes', 30),
      a('strength', 'Do {m} minutes of strength: squats, lunges, calf raises, planks', 'Strength session logged', 20),
      a('quality_run', 'Run {m} minutes including four 1-minute faster pieces with easy jogs between', 'Run logged with the four pieces', 35),
      a('recovery_walk', 'Walk {m} minutes easy and note how your legs feel', 'Walk and leg note logged', 20),
      a('long_run', 'Run {m} minutes easy as this week\'s long run', 'Long run logged with minutes', 45),
      a('long_run_build', 'Run {m} minutes easy as this week\'s long run', 'Long run logged with minutes', 60),
      a('long_run_peak', 'Run {m} minutes easy as this week\'s long run', 'Long run logged with minutes', 75),
      a('race_rehearsal', 'Run {m} minutes in your race-day kit at goal effort for the middle third', 'Rehearsal logged with kit notes', 45),
      a('weekly_score', 'Score the week: runs done (x/4), longest run minutes, and next week\'s runs placed in the calendar', 'Weekly numbers logged and runs scheduled', 15, ['Write next week\'s four run days in your log', 'Run days written', 3]),
    ],
    setup: ['setup_race'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: four runs a week with no two-day gap in training, and the race registered.',
        milestones: [[3, 'Race registered and run slots saved'], [20, 'Three straight weeks of four runs'], [30, 'Long run at 45 minutes']],
        week: ['weekly_score', 'easy_run', 'strength', 'quality_run', 'recovery_walk', 'easy_run', 'long_run'],
      },
      {
        outcome: 'Build: long run grows toward race duration while easy days stay easy.',
        milestones: [[45, 'Long run at 60 minutes'], [55, 'Strength done every week of this gate'], [60, 'No missed-twice gaps this gate']],
        week: ['weekly_score', 'easy_run', 'strength', 'quality_run', 'recovery_walk', 'easy_run', 'long_run_build'],
      },
      {
        outcome: 'Establish: a race rehearsal in full kit and a training rhythm you could keep after race day.',
        milestones: [[70, 'Long run at 75 minutes'], [80, 'Race rehearsal done in race kit'], [90, 'Race run or next race chosen']],
        week: ['weekly_score', 'easy_run', 'strength', 'quality_run', 'recovery_walk', 'race_rehearsal', 'long_run_peak'],
      },
    ],
    decisionCriteria: ['Runs completed against plan', 'Longest run against race duration', 'Healthy and still wanting the next race'],
    safety,
  };
}

function examTemplate(): TemplateSpec {
  const p: PlanPillar = 'execution';
  const mvd: ActionSpec['mvd'] = ['Do 10 practice questions on the next tested topic', '10 questions done and misses marked', 15];
  const a = (key: string, title: string, output: string, minutes: number): ActionSpec => ({ key, title, output, minutes, pillar: p, mvd });
  return {
    key: 'generic.exam',
    pillar: p,
    label: 'Exam preparation',
    actions: [
      a('setup_exam', 'Write the exam date, every tested topic with its weight, and book the exam if it is not booked', 'Exam booked and weighted topic list saved', 30),
      a('practice', 'Do {m} minutes of practice questions on the highest-weight weak topic and mark every miss', 'Question count and marked misses logged', 45),
      a('flashcards', 'Turn yesterday\'s missed questions into flashcards and drill them once', 'New flashcards made and drilled', 30),
      a('teach_back', 'Explain one topic out loud from memory for {m} minutes and write the gaps', 'Gap list for one topic', 20),
      a('timed_section', 'Take one timed practice section under exam conditions and score it', 'Scored timed section logged', 60),
      a('full_mock', 'Take a full-length practice exam under exam conditions and score it', 'Full mock score logged by topic', 180),
      a('error_log', 'Sort this week\'s misses by topic and pick next week\'s two weakest topics', 'Error log sorted and two topics chosen', 30),
      a('weekly_score', 'Score the week: questions done, accuracy %, and next week\'s weakest topic', 'Three numbers logged', 15),
    ],
    setup: ['setup_exam'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: a weighted topic list, a booked exam date, and a baseline score from one timed section.',
        milestones: [[3, 'Exam booked and topics weighted'], [14, 'Baseline timed section scored'], [30, 'Every topic practised at least once']],
        week: ['weekly_score', 'practice', 'flashcards', 'practice', 'teach_back', 'practice', 'timed_section'],
      },
      {
        outcome: 'Build: accuracy rises on the two weakest topics, measured weekly.',
        milestones: [[45, 'First full-length mock scored'], [55, 'Weakest topic accuracy up on the baseline'], [60, 'Error log kept every week']],
        week: ['weekly_score', 'practice', 'flashcards', 'error_log', 'teach_back', 'practice', 'full_mock'],
      },
      {
        outcome: 'Establish: two full mocks at or above the target score, and exam-day logistics written.',
        milestones: [[75, 'Mock at target score'], [85, 'Second mock at target score'], [90, 'Exam sat or rescheduled with a reason']],
        week: ['weekly_score', 'practice', 'flashcards', 'timed_section', 'error_log', 'practice', 'full_mock'],
      },
    ],
    decisionCriteria: ['Mock score against target', 'Accuracy trend on the weakest topics', 'Exam still the right next step'],
    safety: emptySafety(),
  };
}

function creativeTemplate(): TemplateSpec {
  const p: PlanPillar = 'execution';
  const mvd: ActionSpec['mvd'] = ['Open the file and finish one defined line, bar or sentence', 'File saved with today\'s addition', 10];
  const a = (key: string, title: string, output: string, minutes: number): ActionSpec => ({ key, title, output, minutes, pillar: p, mvd });
  return {
    key: 'generic.creative_release',
    pillar: p,
    label: 'Creative release',
    actions: [
      a('setup_release', 'Write the release date, the format, and the numbered list of sections that make it done', 'Release date and numbered section list saved', 20),
      a('produce', 'Produce the next numbered section (page, verse, scene or track) in a {m}-minute block and save it dated', 'Dated section saved', 45),
      a('share_draft', 'Send the latest section to one trusted reader or listener with one specific question', 'Section sent with a question', 10),
      a('polish', 'Polish one finished section and mark it final in the section list', 'One section marked final', 45),
      a('logistics', 'Book one release step: distributor, publisher, venue, upload slot or cover artist', 'One release step booked', 30),
      a('announce', 'Write and schedule one announcement post with the release date', 'Announcement scheduled', 20),
      a('weekly_score', 'Score the week: sections produced, sections final, release date still on track', 'Three numbers logged', 15),
    ],
    setup: ['setup_release'],
    floors: [],
    gates: [
      {
        outcome: 'Foundation: the numbered section list exists and a third of the sections are drafted.',
        milestones: [[3, 'Release date and section list written'], [15, 'First section shared for feedback'], [30, 'One third of sections drafted']],
        week: ['weekly_score', 'produce', 'produce', 'share_draft', 'produce', 'produce', 'polish'],
      },
      {
        outcome: 'Build: every section drafted and release logistics booked.',
        milestones: [[45, 'Two thirds drafted'], [55, 'Release logistics booked'], [60, 'Every section drafted']],
        week: ['weekly_score', 'produce', 'polish', 'logistics', 'produce', 'share_draft', 'polish'],
      },
      {
        outcome: 'Establish: every section final, the release announced, and the work out.',
        milestones: [[75, 'Every section final'], [80, 'Release announced'], [90, 'Released']],
        week: ['weekly_score', 'polish', 'polish', 'announce', 'logistics', 'polish', 'produce'],
      },
    ],
    decisionCriteria: ['Sections final against the list', 'Release date held', 'Still the work you want out'],
    safety: emptySafety(),
  };
}

function otherTemplate(goalText: string): TemplateSpec {
  const p: PlanPillar = 'execution';
  const goal = shortGoal(goalText);
  const mvd: ActionSpec['mvd'] = ['Do the next 10-minute step on deliverable #1 and save it', 'One saved step on deliverable #1', 10];
  const a = (key: string, title: string, output: string, minutes: number): ActionSpec => ({ key, title, output, minutes, pillar: p, mvd });
  return {
    key: 'generic.other',
    pillar: p,
    label: goal,
    actions: [
      a('setup_finish', `Write the finish line for "${goal}" in one sentence and list the three deliverables that prove it`, 'One-sentence finish line and three named deliverables saved', 20),
      a('setup_slots', 'Put three 45-minute work blocks for deliverable #1 in this week\'s calendar', 'Three calendar blocks saved', 10),
      a('produce', `Spend {m} minutes producing deliverable #1 for "${goal}" and save it dated`, 'Dated, saved piece of deliverable #1', 45),
      a('unblock', 'Send one message that unblocks the goal: an ask, a booking, a purchase or an introduction', 'One unblocking message sent', 15),
      a('produce_next', `Spend {m} minutes producing the next deliverable for "${goal}" and save it dated`, 'Dated, saved piece of the next deliverable', 45),
      a('show_someone', 'Show one finished piece to someone whose opinion matters and write their one-line reaction', 'Reaction written in your log', 20),
      a('weekly_score', 'Score the week: deliverables finished (x/3) and next week\'s three blocks placed in the calendar', 'Count logged and three blocks scheduled', 15),
    ],
    setup: ['setup_finish', 'setup_slots'],
    floors: [],
    gates: [
      {
        outcome: `Foundation: prove the concept. The finish line for "${goal}" is written and deliverable #1 exists.`,
        milestones: [[2, 'Finish line and three deliverables written'], [15, 'Deliverable #1 half done'], [30, 'Deliverable #1 finished']],
        week: ['weekly_score', 'produce', 'unblock', 'produce', 'produce', 'show_someone', 'produce'],
      },
      {
        outcome: 'Build: deliverable #2 finished, using what worked on #1.',
        milestones: [[45, 'Deliverable #2 half done'], [55, 'Feedback on #2 written'], [60, 'Deliverable #2 finished']],
        week: ['weekly_score', 'produce_next', 'unblock', 'produce_next', 'produce_next', 'show_someone', 'produce_next'],
      },
      {
        outcome: 'Establish: deliverable #3 finished and the finish line met or re-scoped in writing.',
        milestones: [[75, 'Deliverable #3 half done'], [85, 'Deliverable #3 finished'], [90, 'Finish line met or re-scoped']],
        week: ['weekly_score', 'produce_next', 'unblock', 'produce_next', 'show_someone', 'produce_next', 'produce_next'],
      },
    ],
    decisionCriteria: ['Deliverables finished (x/3)', 'Days with a saved piece of work', 'Still aligned with what you want'],
    safety: emptySafety(),
  };
}

// ---------------------------------------------------------------------------
// Parent+ wrapper (Home Front rules)
// ---------------------------------------------------------------------------

function withHomeFront(base: TemplateSpec): TemplateSpec {
  const floorKey = 'family_floor';
  const family: ActionSpec[] = [
    {
      key: floorKey,
      title: 'Protected family touchpoint for {m} minutes: dinner, bedtime or the school run, with your phone in another room',
      output: 'Touchpoint done with the phone away',
      minutes: 20,
      pillar: 'family',
      mvd: ['One protected family touchpoint (a meal, bedtime or the school run) with your phone away', 'Touchpoint done', 15],
      satisfies: [floorKey],
    },
    {
      key: 'family_setup',
      title: 'Write your daily hard-stop time and put this week\'s family blocks in the calendar as fixed events',
      output: 'Hard stop written and family blocks saved in the calendar',
      minutes: 15,
      pillar: 'family',
      mvd: ['Write tonight\'s hard-stop time and tell your household', 'Hard stop shared', 3],
    },
    {
      key: 'family_week',
      title: 'Score the week, then put next week\'s family blocks and hard stops in the calendar and resolve every work clash now',
      output: 'Weekly numbers logged and next week\'s family blocks fixed',
      minutes: 20,
      pillar: 'family',
      mvd: ['Put next week\'s one most important family block in the calendar', 'Family block saved', 5],
    },
  ];
  const safety: PlanSafety = {
    ...base.safety,
    reasonCodes: [...base.safety.reasonCodes, 'home.floor_protected'],
    notes: [...base.safety.notes, 'A family touchpoint is protected every day, including the heaviest ones.'],
  };
  return {
    ...base,
    key: `parent_plus.${base.key}`,
    actions: [...base.actions, ...family],
    setup: ['family_setup', ...base.setup],
    floors: [...base.floors, floorKey],
    gates: base.gates.map((gate) => ({
      ...gate,
      week: ['family_week', ...gate.week.slice(1)] as GateSpec['week'],
    })) as TemplateSpec['gates'],
    decisionCriteria: [...base.decisionCriteria, 'Family touchpoints kept (x/90 days)'],
    safety,
  };
}

export function templateFor(persona: PersonaMatch, goalText: string, context: GoalPlanContext): TemplateSpec {
  let base: TemplateSpec;
  switch (persona.foregroundPersona) {
    case 'weight_loss':
      base = weightLossTemplate(goalText, context);
      break;
    case 'wealth_building':
      base = wealthTemplate(goalText);
      break;
    case 'founder':
      base = founderTemplate();
      break;
    case 'operator_promotion':
      base = operatorTemplate();
      break;
    default: {
      const kind = persona.genericKind ?? genericKindFor(goalText);
      base = kind === 'race' ? raceTemplate() : kind === 'exam' ? examTemplate() : kind === 'creative_release' ? creativeTemplate() : otherTemplate(goalText);
    }
  }
  return persona.key === 'parent_plus' ? withHomeFront(base) : base;
}

export type { PlanReasonCode };
