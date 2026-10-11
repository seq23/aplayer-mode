/**
 * Search-engine policy for the web app (app.aplayermode.com). The marketing site is
 * aplayermode.com; the app host keeps only its front door indexable and never lets
 * sign-up, account, billing or signed-in routes into search results.
 *
 * Fail-closed: a route is indexable only if it is on INDEXABLE_PATHS; every other route
 * (including any route added later) gets noindex.
 */
export const INDEXABLE_PATHS: readonly string[] = ['/', '/welcome'];
export const NOINDEX = 'noindex, nofollow';

export function isIndexable(pathname: string | null | undefined): boolean {
  const path = ((pathname ?? '/').split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/';
  return INDEXABLE_PATHS.includes(path);
}

/** Minimal document shape so this runs (and is tested) without a DOM. */
type HeadDoc = {
  head: { querySelector(sel: string): { setAttribute(n: string, v: string): void; remove(): void } | null; appendChild(el: unknown): unknown };
  createElement(tag: string): { setAttribute(n: string, v: string): void };
};

/** Sets or clears <meta name="robots"> for the current route. */
export function applyRobots(pathname: string | null | undefined, doc: HeadDoc): void {
  const existing = doc.head.querySelector('meta[name="robots"]');
  if (isIndexable(pathname)) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.setAttribute('content', NOINDEX);
    return;
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'robots');
  meta.setAttribute('content', NOINDEX);
  doc.head.appendChild(meta);
}
