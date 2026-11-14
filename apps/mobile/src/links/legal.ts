import type { IconName } from '../components/ui';
/** The three legal pages, each with ONE source: Terms and Privacy live in this app's public/, the Disclaimer on aplayermode.com. */
export const LEGAL_LINKS = [
  { icon: 'file-text' as IconName, title: 'Terms of Service', detail: 'Your plan, renewal, cancelling and refunds.', url: 'https://app.aplayermode.com/terms' },
  { icon: 'lock' as IconName, title: 'Privacy Policy', detail: 'What leaves your phone, and who sees it.', url: 'https://app.aplayermode.com/privacy' },
  { icon: 'info' as IconName, title: 'Disclaimer', detail: 'Not advice, no promised results, how AI is used.', url: 'https://aplayermode.com/disclaimer/' },
] as const;
