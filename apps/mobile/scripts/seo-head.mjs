// Adds the search/social tags to Expo's exported index.html (idempotent). The app host must not
// compete with the marketing site (https://aplayermode.com/): canonical is the app's own root, and
// per-route noindex is set at runtime by src/web/robots.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://app.aplayermode.com';
export const DESCRIPTION = 'A Player Mode: your personal executive operating system. It plans, sequences and prioritizes your day. Sign in or start your plan.';
export const OG_IMAGE = `${ORIGIN}/icons/icon-512.png`;

export const SEO_TAGS = [
  `<meta name="description" content="${DESCRIPTION}">`,
  `<link rel="canonical" href="${ORIGIN}/">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="A Player Mode">',
  '<meta property="og:title" content="A Player Mode">',
  `<meta property="og:description" content="${DESCRIPTION}">`,
  `<meta property="og:url" content="${ORIGIN}/">`,
  `<meta property="og:image" content="${OG_IMAGE}">`,
  '<meta name="twitter:card" content="summary">',
];

export function addSeoHead(html) {
  if (!html.includes('</head>')) throw new Error('no </head>');
  const missing = SEO_TAGS.filter((tag) => !html.includes(tag));
  return missing.length ? html.replace('</head>', `${missing.join('')}</head>`) : html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const html = addSeoHead(readFileSync(file, 'utf8'));
  writeFileSync(file, html);
  console.log('seo-head: tags present');
}
