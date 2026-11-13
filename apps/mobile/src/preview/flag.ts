// The free web preview of the phone app (.github/workflows/app-preview.yml): sample data only,
// no real sign-in, no purchase, no call to the production API. Inlined at build time; a store
// build never sets it.
export const PREVIEW = process.env.EXPO_PUBLIC_APM_PREVIEW === '1';

export const PREVIEW_COPY = {
  purchases: 'Purchases are switched off in this preview. In the phone app, plans are bought through the App Store or Google Play.',
  samplePlan: 'Continue with a sample plan',
  signIn: 'Preview: no real sign-in. Any email and any 6 digits work, and nothing is sent.',
} as const;
