// Adds the installable-web-app tags to Expo's exported index.html (idempotent).
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
let html = readFileSync(file, 'utf8');
const tags = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#1E1C19">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="APM">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
].filter((tag) => !html.includes(tag));
if (tags.length) html = html.replace('</head>', `${tags.join('')}</head>`);
if (!html.includes('rel="manifest"')) throw new Error('no </head> in ' + file);
writeFileSync(file, html);
console.log(`pwa-head: ${tags.length} tags added`);
