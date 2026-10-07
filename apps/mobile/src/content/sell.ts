// The selling copy: the welcome page and the plan choice (paywall), in ONE typed module
// (no copy scattered through JSX). Adapted from the aplayermode.com pitch for an APP: APM
// runs the system for you; nothing is pasted into another AI, and nothing is bought here
// outside the stores. Prices come from @apm/policy (ADR-0004/0005), Track names from the one
// display-name map, so this copy can never drift from what is sold.
// Pure TS (no React Native imports) so apps/mobile/test can pin it in Node.
import { TRACK_DISPLAY_NAMES, type ActiveTrackKey } from '@apm/domain';
import { CHIEF_OF_STAFF_INTRO_OFFERS, PLAN_PRICES, formatUsdCents, type PaidPlan } from '@apm/policy';

export const CTA_LABEL = 'Start: reduce my load';
export const HAVE_ACCOUNT_LABEL = 'I already have an account';
export const PRIVACY_LINE = 'Your data is yours. Private-life AI runs only on zero-retention, no-training routes.';
export const PRIVACY_LINK_LABEL = 'How APM protects your data';
export const WELCOME_PLATE = 'Your brain stops holding every project, role, rule and restart alone.';

export interface Card { title: string; body: string }

export const HERO = {
  eyebrow: 'A Player Mode',
  headline: 'Reduce your cognitive load.',
  sub: 'Whatever game you\'re in, get into A Player Mode. Your personal executive operating system plans, sequences, prioritises and catches you after bad days, so your brain stops holding every project, role, rule and restart alone.',
  emptyLine: 'Running on empty? Tap Start. You can stop after 3 minutes with a plan that already works.',
  definitionTitle: 'What A-player mode means',
  definition: [
    'Clearer priorities.',
    'Cleaner execution.',
    'Faster recovery after imperfect days.',
    'Less renegotiating with yourself.',
  ],
  notThis: 'It is not perfection. It is not hustle cosplay. It is not waking up at 4 a.m. pretending you are a machine. It is a system that keeps you moving when motivation, mood and pressure change.',
} as const;

export const CONTINUITY = {
  title: 'You don\'t have a knowledge problem. You have a continuity problem.',
  body: 'You can plan. You can think clearly. You can design the perfect system. And life still runs in the same loop:',
  loop: ['Clarity', 'Motivation', 'Strong Start', 'Missed Day', 'Avoidance', 'Reset', 'New Plan', 'Repeat'],
  close: 'You are not lazy. You are overloaded.',
  detail: 'Too many projects, roles, decisions and restarts, and nothing holding the plan between days. APM is that layer: when yesterday breaks, today is already waiting.',
} as const;

export const FIVE_ROLES = {
  title: 'Five jobs in one',
  framing: 'Billionaires do not rely on motivation. They buy structure: a coach for clarity, a chief of staff for sequencing, an accountability partner for follow-through. Most people are expected to do all of that alone. APM runs that support stack for you, every day.',
  roles: [
    { title: 'Executive Coach', body: 'Calm, clear direction under pressure. You stop talking yourself in circles.' },
    { title: 'Executive Assistant', body: 'Sequences the day and tells you exactly where to start. You stop deciding what is first.' },
    { title: 'Chief of Staff', body: 'Keeps projects, priorities and long-term goals lined up. You stop holding the whole map.' },
    { title: 'Accountability Partner', body: 'Holds the line between days when motivation disappears. You stop restarting.' },
    { title: 'Cognitive Behavioral Mindset Coach', body: 'Interrupts the spiral after a miss and gets you back to one small action. You stop the shame loop.' },
  ] as readonly Card[],
} as const;

export const PERSONAS = {
  title: 'For anyone who wants to be an A player in whatever game they\'re playing',
  personas: [
    { title: 'Wealth building', thought: '"Am I doing the right thing with my money?"', plate: 'Saving runs by default, one debt at a time, a buffer before any bets, and subscriptions flagged.' },
    { title: 'Weight loss', thought: '"What do I eat and when do I work out today?"', plate: 'The day\'s workout and food steps, at a safe pace; a 10-minute walk counts on hard days.' },
    { title: 'Founder / Entrepreneur', thought: '"What actually moves the business today, and who am I forgetting to follow up?"', plate: 'One foreground priority, dropped follow-ups caught, decisions run through ownership and leverage filters.' },
    { title: 'Operator', thought: '"Am I doing the work that gets me promoted?"', plate: 'Real work in front of fake work, visible results on the calendar, no quiet renegotiation.' },
    { title: 'Parent+', thought: '"Did I forget a pickup, form, birthday or appointment?"', plate: 'Family time is booked first and defended like a board meeting; work fits around it.' },
  ],
  alsoFor: ['Creatives and makers', 'Students and researchers', 'Athletes and competitors', 'Career-switchers', 'Executives in a new seat', 'Anyone at 2 a.m. trying to get their life together'],
} as const;

export const INSIDE = {
  title: 'Inside the system',
  parts: [
    { title: 'Daily agenda engine', body: 'Turns the day into one clear stack: your priority first, then the rest, sized to the time you really have.' },
    { title: 'Morning trigger', body: 'Your agenda arrives on its own at the time you chose. You never have to remember to open the app.' },
    { title: 'Never Miss Twice', body: 'One miss is data. The next day shrinks to one small thing so a miss never becomes a lost week.' },
    { title: 'Minimum Viable Day', body: 'On a 2-out-of-10 day: one small thing, close the day, it counts. Zeros are allowed; quitting is not.' },
    { title: 'Arbitration engine', body: 'When everything feels urgent, it picks the one foreground priority by leverage, urgency, energy, compounding and downside.' },
    { title: 'End-of-day check-in', body: 'Closes the loop with evidence: what got done, Hit / Partial / Miss, one insight. No catch-up debt.' },
  ] as readonly Card[],
} as const;

export const MODES = {
  title: 'Coaching modes, one tap away',
  modes: [
    { key: 'high_pressure', title: 'High-Pressure Coaching', body: 'When you are stuck or avoiding: cuts through the noise and ends with one stabilising directive.' },
    { key: 'executive_review', title: 'Executive Review', body: 'When your head is full: no new ideas, no re-diagnosis. Organises the 3 to 7 things you already know.' },
    { key: 'recovery', title: 'Recovery', body: 'After a bad day or in a low season: a minimum day, no catch-up, no guilt.' },
    { key: 'sprint', title: 'Sprint', body: 'When a deadline is close: a short, declared push with one foreground only.' },
    { key: 'deep_work', title: 'Deep Work', body: 'Protects one uninterrupted focus block for one hard task.' },
    { key: 'standard', title: 'Standard', body: 'Normal execution under your operating system.' },
  ] as ReadonlyArray<{ key: string; title: string; body: string }>,
} as const;

const TRACK_PURPOSES: Readonly<Record<ActiveTrackKey, string>> = {
  billionaire_mindset: 'Ownership, leverage, compounding and downside containment for business and venture decisions.',
  operator_discipline: 'The morning plan is executed as written; changes are declared, never drifted into.',
  strategic_patience: 'No premature pivots before the evidence and the 30/60/90 gates justify a change.',
  resilience: 'Protects recovery capacity so a volatile season never breaks continuity.',
  body_foundation: 'Small, tracked body behaviours at a safe pace. Never diet or medical advice.',
  wealth_foundation: 'Save by default, one debt at a time, buffer before bets. Never product advice.',
  home_front: 'Family time is scheduled and defended like the most important meeting of the week.',
};

export const TRACKS = {
  title: 'Tracks: filters that run in the background',
  body: 'Tracks are not more tasks. They quietly shape what APM puts in front of you. APM suggests the ones that fit your game; you approve them.',
  tracks: (Object.keys(TRACK_DISPLAY_NAMES) as ActiveTrackKey[]).map((key) => ({ key, title: TRACK_DISPLAY_NAMES[key], body: TRACK_PURPOSES[key] })),
  spotlight: {
    key: 'billionaire_mindset' as ActiveTrackKey,
    label: 'Spotlight',
    title: TRACK_DISPLAY_NAMES.billionaire_mindset,
    body: 'For founders, owners and anyone holding equity. Every opportunity and priority is run through four filters: still right in 10 years? Upside versus downside? Is the worst case survivable? Does it scale without you? It prefers ownership to income and leverage to activity, and it runs with High-Pressure Coaching, pre-selected for you when the Track fits your game.',
  },
} as const;

export const SITUATIONS = {
  title: 'Situations it handles automatically',
  rows: [
    ['You wake up with resistance', 'Morning Start Sequence'],
    ['You missed yesterday', 'Recovery Day'],
    ['You missed a day and feel shame', 'No-Catch-Up reset'],
    ['You are overwhelmed', 'Stabilisation'],
    ['Too many priorities', 'Arbitration'],
    ['You are burned out', 'Minimum Viable Day'],
    ['You lost momentum', 'Re-entry'],
    ['You want to rebuild your whole system', 'No-Redesign stabilisation'],
  ] as ReadonlyArray<readonly [string, string]>,
  close: 'No guessing. No negotiating with yourself. No rebuilding systems.',
} as const;

export const WITHOUT_WITH = {
  title: 'Advice versus a system',
  without: {
    label: 'Asking an AI for advice',
    lines: [
      'You: "I have six things to do and I keep not starting."',
      'AI: "Try breaking tasks into smaller steps and time-blocking."',
      'You: "I know. I\'m still not doing it."',
    ],
    result: 'Helpful. Clear. Nothing changed. Tomorrow you have the same conversation.',
  },
  with: {
    label: 'A Player Mode',
    lines: [
      'You: "I\'m avoiding everything and want to reorganise my whole system."',
      'APM: "Don\'t reorganise. Today is a stabilisation day: one 20-minute action on one project. Name the step."',
      'You: "The investor follow-ups I\'ve been avoiding."',
      'APM: "Send 2, not all of them. Then tell me done."',
    ],
    result: 'It did not give advice. It regulated the day, and tomorrow continues instead of restarting.',
  },
} as const;

// ---------------------------------------------------------------------------
// Prices, offers and the tier grids (the grids live on the plan choice screen)
// ---------------------------------------------------------------------------

const PAID: readonly PaidPlan[] = ['chief_of_staff', 'life_os', 'autopilot'];
export const monthly = (plan: PaidPlan) => formatUsdCents(PLAN_PRICES[plan].monthlyUsdCents);
export const annual = (plan: PaidPlan) => formatUsdCents(PLAN_PRICES[plan].annualUsdCents);
const introCents = CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents;
const listCents = PLAN_PRICES.chief_of_staff.monthlyUsdCents;
export const INTRO_PRICE = formatUsdCents(introCents);
export const LIST_PRICE = formatUsdCents(listCents);
export const INTRO_SAVING_PERCENT = Math.round(((listCents - introCents) / listCents) * 100);

/** Section 10 of the welcome page: a one-line teaser; the grids are on the plan screen. */
export const WELCOME_TIERS_TEASER = {
  title: 'Three levels of help',
  line: PAID.map((plan) => `${PLAN_PRICES[plan].displayName} ${PLAN_PRICES[plan].tagline}`).join(' · '),
  offer: `Introductory offer: start at ${INTRO_PRICE}/month`,
} as const;

export interface OfferBanner {
  kind: 'founding' | 'introductory';
  ribbon: string;
  headline: string;
  /** The struck-through list price. */
  was: string;
  now: string;
  saving: string;
  explain: string;
  /** Only the server's number, e.g. "37 of 100 spots left"; absent when unknown. */
  scarcity?: string;
}

/**
 * The introductory-offer banner. `founding` and `spotsLeft` come only from the server
 * (GET /v1/billing/offering); a missing count hides the scarcity line, never invents one.
 */
export function offerBanner(input: { founding: boolean; spotsLeft?: number | null }): OfferBanner {
  const spots = typeof input.spotsLeft === 'number' && Number.isInteger(input.spotsLeft) && input.spotsLeft >= 0 ? input.spotsLeft : undefined;
  const foundingOpen = input.founding && spots !== 0;
  const common = { was: `${LIST_PRICE}/month`, now: `${INTRO_PRICE}/month`, saving: `Save ${INTRO_SAVING_PERCENT}%` };
  if (foundingOpen) {
    return {
      kind: 'founding',
      ribbon: 'Introductory offer',
      headline: 'Introductory offer — Founding Member price',
      ...common,
      explain: `For our first ${CHIEF_OF_STAFF_INTRO_OFFERS.founding100.subscribers} members only. Your price stays ${INTRO_PRICE} for as long as you stay subscribed.`,
      ...(spots !== undefined ? { scarcity: `${spots} of ${CHIEF_OF_STAFF_INTRO_OFFERS.founding100.subscribers} spots left` } : {}),
    };
  }
  return {
    kind: 'introductory',
    ribbon: 'Introductory offer',
    headline: `Introductory offer: ${INTRO_PRICE}/month for your first ${CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months, then ${LIST_PRICE}`,
    ...common,
    explain: `New members pay ${INTRO_PRICE}/month for the first ${CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months, then ${LIST_PRICE}/month. Cancel any time in your store settings.`,
  };
}

export const TIER_GRID_WHO = {
  title: 'Who carries it',
  note: 'Every level lifts load. Each one includes the one below.',
  columns: PAID.map((plan) => PLAN_PRICES[plan].displayName),
  rows: [
    { label: 'You stop having to…', cells: ['decide', 'remember and prepare', 'do the routine work'] },
    { label: 'It carries', cells: ['What to do, when, and what matters most', 'Everything else in your life, ready to approve', 'The repeat work, done inside your rules'] },
    { label: 'Left on you', cells: ['Doing the plan', 'Tapping Approve', 'Reading the done-list'] },
    { label: 'Monthly', cells: PAID.map((plan) => monthly(plan)) },
    { label: 'Annual (2 months free)', cells: PAID.map((plan) => annual(plan)) },
  ],
} as const;

export const TIER_GRID_WHAT = {
  title: 'What you no longer think about',
  columns: PAID.map((plan) => `${PLAN_PRICES[plan].displayName} (${plan === 'chief_of_staff' ? 'decides it' : plan === 'life_os' ? 'prepares it' : 'does it'})`),
  rows: [
    { label: '"What should I do today?"', cells: ['Agenda arrives, already prioritised', '+ covers family, home, health, money', '+ books the time on your calendar'] },
    { label: '"Am I forgetting something?"', cells: ['Radar catches dropped promises and deadlines', '+ birthdays, bills, appointments, renewals', '+ sends the follow-ups and confirmations'] },
    { label: '"How do I even start this goal?"', cells: ['Turns the goal into a plan and daily steps', '+ the supporting logistics', '+ books it and keeps it booked'] },
    { label: '"I missed yesterday, now I\'m behind"', cells: ['Minimum day, no catch-up, no guilt', '+ pushes back non-urgent life tasks', '+ reschedules and sends the "need to move" notes'] },
    { label: '"I\'m overwhelmed and stuck"', cells: ['Coaching, one question at a time', '+ takes life admin off your plate that day', '+ clears your calendar to your minimum day'] },
    { label: '"Who do I owe a reply to?"', cells: ['Flags it', 'Drafts it', 'Sends it'] },
    { label: '"Is my calendar realistic?"', cells: ['Flags overload and clashes', 'Proposes the fix', 'Moves flexible items, protects focus time'] },
    { label: '"Am I wasting money on subscriptions?"', cells: ['—', 'Flags unused ones and price rises', 'Cancels them (saves money, never spends it)'] },
  ],
} as const;

export const PLAN_SCREEN = {
  title: 'How much should APM carry?',
  plate: 'Every tier lifts load. Higher tiers lift more.',
  annualLine: 'Annual = 2 months free.',
  autonomyLine: 'Buying a tier never grants autonomy: you switch on each permission yourself, and you can revoke it.',
  betaLine: 'Closed beta: the prices are shown, nothing is charged.',
} as const;

/** Recommended tier: most parents start with Life OS; everyone else with Chief of Staff. */
export function recommendedTier(games: readonly string[]): PaidPlan {
  return games.includes('parent') ? 'life_os' : 'chief_of_staff';
}

export interface WelcomeSection { id: string; title: string }

/** The welcome page, in its scannable order (11 sections, CTA repeated at the end). */
export const WELCOME_SECTIONS: readonly WelcomeSection[] = [
  { id: 'hero', title: HERO.headline },
  { id: 'continuity', title: CONTINUITY.title },
  { id: 'roles', title: FIVE_ROLES.title },
  { id: 'personas', title: PERSONAS.title },
  { id: 'inside', title: INSIDE.title },
  { id: 'modes', title: MODES.title },
  { id: 'tracks', title: TRACKS.title },
  { id: 'situations', title: SITUATIONS.title },
  { id: 'without_with', title: WITHOUT_WITH.title },
  { id: 'tiers', title: WELCOME_TIERS_TEASER.title },
  { id: 'privacy', title: 'Your data is yours' },
];

/** Every string the welcome page renders (the test pins content against it). */
export function welcomeText(): string {
  return JSON.stringify([HERO, CONTINUITY, FIVE_ROLES, PERSONAS, INSIDE, MODES, TRACKS, SITUATIONS, WITHOUT_WITH, WELCOME_TIERS_TEASER, PRIVACY_LINE, CTA_LABEL, WELCOME_SECTIONS]);
}

/** Every string the plan screen renders above the purchase options. */
export function planScreenText(banner: OfferBanner): string {
  return JSON.stringify([PLAN_SCREEN, TIER_GRID_WHO, TIER_GRID_WHAT, banner]);
}
