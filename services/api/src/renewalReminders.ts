import { PLAN_PRICES, formatUsdCents, type PaidPlan } from '@apm/policy';
import type { ApiEnv } from './env';
import { SupabaseRestError, serviceRpc } from './db';

/**
 * Annual renewal reminder (risk R-SUB-03; California B&P 17602(b): a notice 15 to 45 days before
 * an auto-renewal of a year or longer). Migration 0098.
 *
 * Once a day (the 15:00 UTC cron tick, 9 or 10 am Central) the API emails each active,
 * auto-renewing annual plan bought by card (web) or through the App Store whose period ends 15 to
 * 45 days out, once per renewal. A reminder is recorded only after the email provider accepted
 * it, so a failed send is retried at the next daily run while the window lasts. Google Play
 * sends its own annual-renewal reminders.
 *
 * Every run prints one `OUTPUT <n> renewal_reminders_sent` line; zero is a NAMED STOP that says why.
 */

export const REMINDER_HOUR_UTC = 15;
export const REMINDER_FROM = 'A Player Mode <billing@mail.aplayermode.com>';
export const SUPPORT_EMAIL = 'support@aplayermode.com';
export const MANAGE_PLAN_URL = 'https://app.aplayermode.com/settings/plan';

export interface DueReminder { userId: string; email: string; plan: PaidPlan; provider: 'web' | 'app_store'; periodEnd: string }
export interface RenewalReminderResult {
  output: string;
  sent: number;
  due: number;
  failed: number;
  annualActive: number | null;
  stop?: 'NOT_THIS_TICK' | 'NO_SERVICE_CREDENTIAL' | 'MIGRATION_MISSING' | 'NONE_DUE' | 'EMAIL_NOT_CONFIGURED' | 'SEND_FAILED';
}

const PLAN_NAMES: Record<PaidPlan, string> = { chief_of_staff: 'Executive Roundtable', life_os: 'Executive Suite', autopilot: 'Autopilot' };

/** "December 28, 2026" in UTC (the renewal instant RevenueCat reports). */
export function renewalDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

/** The reminder itself: plain text, price, date, how to cancel, a link. */
export function renewalReminderEmail(due: DueReminder): { subject: string; text: string } {
  const date = renewalDateLabel(due.periodEnd);
  const plan = PLAN_NAMES[due.plan];
  const price = formatUsdCents(PLAN_PRICES[due.plan].annualUsdCents);
  const charged = due.provider === 'app_store' ? 'Apple charges it to your Apple ID.' : 'It is charged to the card on file.';
  const cancel = due.provider === 'app_store'
    ? 'To cancel before it renews: on your iPhone open Settings, tap your name, then Subscriptions, then A Player Mode, and tap Cancel Subscription. In the app, Settings, Plan, Manage subscription opens the same page. No call is needed.'
    : 'To cancel before it renews: in A Player Mode, open Settings, then Plan, then Manage subscription, and cancel there (the "Manage subscription" link in your receipt email works too). No call is needed.';
  const text = [
    `Your annual A Player Mode plan renews automatically on ${date}.`,
    '',
    `Plan: ${plan}, yearly`,
    `Price: ${price} for the next year. ${charged}`,
    `Renews on: ${date}`,
    '',
    'You do not need to do anything to keep it.',
    '',
    cancel,
    `If you cancel, you keep everything until ${date} and are not charged again.`,
    '',
    `See your plan: ${MANAGE_PLAN_URL}`,
    '',
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    '',
    'A Player Mode, by Spry Labs',
    'You are getting this because your yearly plan renews automatically. We send this notice once before each yearly renewal.',
  ].join('\n');
  return { subject: `Your A Player Mode plan renews on ${date}`, text };
}

function isDue(value: unknown): value is DueReminder {
  const d = value as Partial<DueReminder> | null;
  return !!d && typeof d.userId === 'string' && typeof d.email === 'string' && d.email.includes('@')
    && typeof d.periodEnd === 'string' && !Number.isNaN(Date.parse(d.periodEnd))
    && (d.provider === 'web' || d.provider === 'app_store') && typeof d.plan === 'string' && d.plan in PLAN_NAMES;
}

function result(sent: number, due: number, failed: number, annualActive: number | null, stop?: RenewalReminderResult['stop']): RenewalReminderResult {
  const census = `OUTPUT ${sent} renewal_reminders_sent due=${due} failed=${failed} annual_active=${annualActive ?? 'unknown'}`;
  return { output: stop ? `${census} NAMED STOP [${stop}]` : census, sent, due, failed, annualActive, ...(stop ? { stop } : {}) };
}

export async function runRenewalReminders(env: ApiEnv, now: Date, fetcher: typeof fetch = fetch): Promise<RenewalReminderResult> {
  if (now.getUTCHours() !== REMINDER_HOUR_UTC || now.getUTCMinutes() >= 15) return result(0, 0, 0, null, 'NOT_THIS_TICK');
  if (!env.SUPABASE_SECRET_KEY) return result(0, 0, 0, null, 'NO_SERVICE_CREDENTIAL');
  let listed: { annualActive?: unknown; due?: unknown };
  try {
    listed = await serviceRpc(env, 'apm_service_billing_renewal_reminders_due', { p_now: now.toISOString() });
  } catch (error) {
    if (error instanceof SupabaseRestError && error.status === 404) return result(0, 0, 0, null, 'MIGRATION_MISSING');
    throw error;
  }
  const annualActive = typeof listed?.annualActive === 'number' ? listed.annualActive : null;
  const due = (Array.isArray(listed?.due) ? listed.due : []).filter(isDue);
  if (due.length === 0) return result(0, 0, 0, annualActive, 'NONE_DUE');
  const key = env.RESEND_API_KEY;
  if (!key) return result(0, due.length, due.length, annualActive, 'EMAIL_NOT_CONFIGURED');
  let sent = 0;
  for (const item of due) {
    const { subject, text } = renewalReminderEmail(item);
    try {
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          // Same renewal, same key: a retry within the provider's window never sends twice.
          'idempotency-key': `apm-renewal-${item.userId}-${Date.parse(item.periodEnd)}`,
        },
        body: JSON.stringify({ from: REMINDER_FROM, to: [item.email], reply_to: SUPPORT_EMAIL, subject, text }),
      });
      if (!response.ok) continue;
      await serviceRpc(env, 'apm_service_billing_renewal_reminder_sent', { p_user_id: item.userId, p_period_end: item.periodEnd });
      sent += 1;
    } catch {
      // Counted as failed below; the next daily run retries while the 15-45 day window lasts.
    }
  }
  const failed = due.length - sent;
  return result(sent, due.length, failed, annualActive, failed > 0 ? 'SEND_FAILED' : undefined);
}
