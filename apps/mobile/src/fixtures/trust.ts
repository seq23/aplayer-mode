export const trustPromises = [
  {
    title: 'Your data is not for sale',
    detail: 'A Player Mode does not sell your personal data.',
  },
  {
    title: 'Private data is not public-model training material',
    detail: 'Approved AI inference providers may not train public models on your private APM data.',
  },
  {
    title: 'Minimum necessary AI context',
    detail: 'APM is designed to send only the context needed for a particular AI task.',
  },
  {
    title: 'You control connections',
    detail: 'Connected services can be disconnected without deleting your APM account.',
  },
  {
    title: 'You control autonomy',
    detail: 'APM cannot silently grant itself more permission to act.',
  },
] as const;

export const providerFixtures = [
  {
    name: 'Private reasoning route',
    use: 'Planning and semantic judgment',
    training: 'No',
    retention: 'ZDR required',
    status: 'Approved policy',
  },
  {
    name: 'Private extraction route',
    use: 'Commitments and structured facts',
    training: 'No',
    retention: 'ZDR required',
    status: 'Approved policy',
  },
  {
    name: 'Free public-data route',
    use: 'Public or synthetic tasks only',
    training: 'Provider-dependent',
    retention: 'Provider-dependent',
    status: 'Restricted',
  },
] as const;

export const dataFixtures = [
  {
    category: 'Goal',
    value: 'Launch the A Player Mode app',
    source: 'You told APM',
    confidence: 'Confirmed',
  },
  {
    category: 'Preference',
    value: 'Protect a focused morning work block',
    source: 'You told APM',
    confidence: 'Confirmed',
  },
  {
    category: 'Commitment',
    value: 'Send David the deck',
    source: 'Fixture: Gmail-derived example',
    confidence: 'High · mock data',
  },
] as const;

export const connectionFixtures = [
  {
    name: 'Google Calendar',
    state: 'Not connected',
    can: 'Nothing yet',
    cannot: 'Read or modify your calendar',
  },
  {
    name: 'Gmail',
    state: 'Not connected',
    can: 'Nothing yet',
    cannot: 'Read, draft, or send email',
  },
] as const;

export const autonomyFixtures = [
  { domain: 'Calendar', level: 'Recommend', detail: 'Suggest changes; do not make them.' },
  { domain: 'Routine planning', level: 'Prepare', detail: 'Prepare blocks for your approval.' },
  { domain: 'Work email', level: 'Prepare', detail: 'Draft; do not send.' },
  { domain: 'Purchases', level: 'Observe', detail: 'No purchasing authority.' },
] as const;

export const activityFixtures = [
  {
    time: 'Today · 8:02 AM',
    title: 'Radar item created',
    detail: 'APM noticed a mock commitment due today. No external service was accessed.',
  },
  {
    time: 'Today · 8:00 AM',
    title: 'Daily plan prepared',
    detail: 'Fixture data only. No AI provider was called.',
  },
  {
    time: 'Yesterday',
    title: 'Privacy Center viewed',
    detail: 'Product transparency event; no private content included in analytics.',
  },
] as const;
