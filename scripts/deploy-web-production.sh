#!/usr/bin/env bash
# Builds the Expo web app against the production API and deploys it, with /terms and /privacy,
# as static assets on the Worker "aplayermode-app" (apps/mobile/wrangler.web.jsonc,
# https://app.aplayermode.com).
# The page is installable ("Add to Home Screen"): manifest, icons, display standalone.
#   scripts/deploy-web-production.sh
set -Eeuo pipefail
cd "$(dirname "$0")/../apps/mobile"
export EXPO_PUBLIC_APM_API_URL="https://api.aplayermode.com"
export EXPO_PUBLIC_SUPABASE_URL="https://klzbnchgoqmnwsgolwoe.supabase.co"
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$(node -e "const s=require('fs').readFileSync('../../services/api/wrangler.jsonc','utf8');process.stdout.write(s.match(/\"SUPABASE_PUBLISHABLE_KEY\": \"(sb_publishable_[^\"]+)\"/)[1])")"
export EXPO_PUBLIC_TERMS_URL="https://app.aplayermode.com/terms"
export EXPO_PUBLIC_PRIVACY_POLICY_URL="https://app.aplayermode.com/privacy"
rm -rf dist
npx expo export --platform web --output-dir dist --clear >/dev/null
grep -rqF "$EXPO_PUBLIC_APM_API_URL" dist/_expo/static/js/web/ || { echo "the API URL is not in the bundle (env not inlined)"; exit 1; }
# Expo's single-page export has no PWA tags: add the manifest, theme colour and iOS home-screen tags.
node scripts/pwa-head.mjs dist/index.html
for f in terms/index.html privacy/index.html manifest.webmanifest icons/icon-512.png legal.css; do test -s "dist/$f" || { echo "missing dist/$f"; exit 1; }; done
npx wrangler deploy --config wrangler.web.jsonc
