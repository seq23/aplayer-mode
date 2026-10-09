// Testimonials for the welcome page and the paywall. The data lives in ONE file,
// apps/mobile/public/testimonials.json, which aplayermode.com also reads from the web app
// (/testimonials.json on app.aplayermode.com). Pure, so apps/mobile/test runs it in Node.
// Real quotes with recorded permission only; the section is hidden while the list is empty.
import data from '../../public/testimonials.json';

export interface Testimonial { quote: string; name: string; context?: string }

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined);

/** Valid entries only (quote, name and a consent record are required; consent is never shown). */
export function validTestimonials(raw: unknown): Testimonial[] {
  const list = (raw as { testimonials?: unknown })?.testimonials;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: Record<string, unknown>) => {
    const quote = text(entry?.quote, 400); const name = text(entry?.name, 80); const consent = text(entry?.consent, 200);
    if (!quote || !name || !consent) return [];
    const context = text(entry?.context, 120);
    return [{ quote, name, ...(context ? { context } : {}) }];
  });
}

export const TESTIMONIALS: readonly Testimonial[] = validTestimonials(data);
export const TESTIMONIALS_TITLE = 'From people using it';
