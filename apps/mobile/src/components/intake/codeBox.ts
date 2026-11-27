import { REVIEW_CODE_MAX_LENGTH, isReviewCodeShape } from '@apm/policy';

/**
 * The code box after "Email me a 6-digit code", for both sign-in screens (AccountPanel and the
 * pay-first claim in app/billing/return.tsx). Everyone gets the 6-digit email code. The App Review
 * account (the server says so: sendEmailCode → { review: true }) gets no email and types the code
 * from the store console instead: today's 6 digits or 12–24 letters and digits, the ONE rule the
 * server checks too (REVIEW_CODE_PATTERN in @apm/policy).
 */
export interface CodeBox {
  title: string;
  lead: (email: string) => string;
  label: string;
  keyboardType: 'number-pad' | 'default';
  maxLength: number;
  clean: (typed: string) => string;
  ready: (code: string) => boolean;
  notReady: string;
}

const EMAIL_CODE: CodeBox = {
  title: 'Check your email',
  lead: (email) => `We sent a 6-digit code to ${email.trim()}. Type it here.`,
  label: '6-digit code',
  keyboardType: 'number-pad',
  maxLength: 6,
  clean: (typed) => typed.replace(/\D/g, '').slice(0, 6),
  ready: (code) => /^\d{6}$/.test(code),
  notReady: 'The code has 6 digits.',
};

const REVIEW_CODE: CodeBox = {
  title: 'Your review code',
  lead: () => 'No email is sent for this account. Type the sign-in code from the review notes, exactly as written.',
  label: 'Review code',
  keyboardType: 'default',
  maxLength: REVIEW_CODE_MAX_LENGTH,
  clean: (typed) => typed.replace(/[^A-Za-z0-9]/g, '').slice(0, REVIEW_CODE_MAX_LENGTH),
  ready: isReviewCodeShape,
  notReady: 'The review code is 6 digits, or 12 to 24 letters and digits.',
};

export function codeBoxFor(review: boolean): CodeBox {
  return review ? REVIEW_CODE : EMAIL_CODE;
}
