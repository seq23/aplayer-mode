// Copy for the 18+ confirmation and the consumer health data consent (owner, 8 Oct 2026).
// Plain words, accurate to what the app collects (packages/planning/src/intake/healthData.ts),
// no medical claims. The full text is public/privacy/consumer-health/index.html.

export const AGE_GATE = {
  eyebrow: 'Before you start',
  title: 'Are you 18 or older?',
  body: 'A Player Mode is for adults. We ask once and keep a dated record of your answer with your account.',
  confirm: "I'm 18 or older",
  under: "I'm under 18",
  underTitle: 'A Player Mode is for adults',
  underBody: 'Sorry, you need to be 18 or older to use A Player Mode, so we cannot set up an account for you.',
  underAccountBody: 'Sorry, you need to be 18 or older to use A Player Mode. You can delete this account and everything in it now.',
  deleteAccount: 'Delete my account',
  back: 'I made a mistake, go back',
} as const;

export const HEALTH_CONSENT = {
  eyebrow: 'Your health information',
  title: 'Can APM use health information you give it?',
  lead: 'This is a separate choice from anything else you agree to. You can change it any time.',
  what: [
    'The Body questions: how you like to move and how many days, food habits, your weight and weigh-in rhythm, and whether you have a daily health routine (APM never stores medication names).',
    'Whether pregnancy, diabetes medication, a heart condition or a history of disordered eating applies to you, whether a clinician supervises your plan, and a clinician clearance you record later.',
    'Whether getting out of bed is hard (it adds a gentle in-bed movement routine), and a weight-loss or injury-return goal if you pick one.',
    'The 1 to 10 energy score you tap each morning, which sizes the day and turns a 2 or lower into a light day, and how full your head feels (1 to 10) at setup.',
  ],
  why: 'APM uses this only to shape your Body steps and keep their pace safe. It is not medical advice. It is never sold or used for ads, and AI providers may not train on it.',
  noLine: 'If you say no, APM skips these questions and the weight-loss goal, and plans your Body steps from general habits only.',
  agree: 'I agree',
  decline: 'Not now',
  policyLink: 'Read the Consumer Health Data Privacy Policy',
} as const;

export const HEALTH_SETTINGS = {
  title: 'Consumer health data',
  subtitle: 'Health information you give APM, under Washington\'s My Health My Data Act and similar laws.',
  on: 'On: APM can collect the health answers listed below.',
  off: 'Off: APM does not collect health answers. Body steps come from general habits only.',
  unset: 'You have not decided yet.',
  withdraw: 'Withdraw consent',
  withdrawNote: 'APM stops collecting health answers at once and drops the ones in your setup answers the next time they save. To delete everything already stored, use Export & Delete.',
  grant: 'Give consent',
  exportDelete: 'Export & Delete',
  policyLink: 'Read the Consumer Health Data Privacy Policy',
  recorded: (decision: string, at: string) => `${decision} on ${at}.`,
} as const;
