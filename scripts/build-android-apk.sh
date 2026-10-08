#!/usr/bin/env bash
# Builds a signed release APK of A Player Mode on this Mac (no Expo account): Expo prebuild,
# a release signing config from an upload keystore, then gradle assembleRelease.
#   APM_KEYSTORE_DIR=<dir with upload.keystore + upload.keystore.password> scripts/build-android-apk.sh
# Needs JDK 17 (JAVA_HOME) and the Android SDK (ANDROID_HOME; platform 37, build-tools 37, NDK 27.1).
# The keystore password is read from its file into the gradle environment; it is never printed.
set -Eeuo pipefail
cd "$(dirname "$0")/../apps/mobile"
: "${APM_KEYSTORE_DIR:?set APM_KEYSTORE_DIR}"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 17}"
: "${ANDROID_HOME:?set ANDROID_HOME}"
export EXPO_PUBLIC_APM_API_URL="https://api.aplayermode.com"
export EXPO_PUBLIC_SUPABASE_URL="https://klzbnchgoqmnwsgolwoe.supabase.co"
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$(node -e "const s=require('fs').readFileSync('../../services/api/wrangler.jsonc','utf8');process.stdout.write(s.match(/\"SUPABASE_PUBLISHABLE_KEY\": \"(sb_publishable_[^\"]+)\"/)[1])")"
export EXPO_PUBLIC_TERMS_URL="https://app.aplayermode.com/terms"
export EXPO_PUBLIC_PRIVACY_POLICY_URL="https://app.aplayermode.com/privacy"
# The sideload APK (aplayermode.com download, not Google Play): card checkout through RevenueCat
# Web Billing instead of Play billing (docs/33 §9). Store builds set "store" (apps/mobile/eas.json).
export EXPO_PUBLIC_APM_DISTRIBUTION="sideload"
# Card payments (RevenueCat Web Billing, docs/33 §9): the Web Purchase Links are public URLs in
# apps/mobile/web-billing.json (an environment variable of the same name overrides); empty = the
# app shows "Card payments open shortly".
eval "$(node scripts/web-billing-env.mjs)"
# A Play billing key in a sideload build would be dead code at best: never pass one.
unset EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY
export NODE_ENV=production
CI=1 npx expo prebuild --platform android --clean --no-install >/dev/null
git checkout -- package.json 2>/dev/null || true   # prebuild rewrites the run scripts; keep ours
node - <<'NODE'
const fs = require('fs');
const p = 'android/app/build.gradle';
let g = fs.readFileSync(p, 'utf8');
const release = `        release {
            storeFile file(System.getenv('APM_UPLOAD_STORE_FILE'))
            storePassword System.getenv('APM_UPLOAD_STORE_PASSWORD')
            keyAlias 'upload'
            keyPassword System.getenv('APM_UPLOAD_STORE_PASSWORD')
        }
`;
if (!g.includes("keyAlias 'upload'")) g = g.replace(/(signingConfigs \{\n)/, `$1${release}`);
g = g.replace(/(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
if (!/signingConfig signingConfigs\.release/.test(g)) throw new Error('release signing not wired');
fs.writeFileSync(p, g);
NODE
export APM_UPLOAD_STORE_FILE="$APM_KEYSTORE_DIR/upload.keystore"
APM_UPLOAD_STORE_PASSWORD="$(cat "$APM_KEYSTORE_DIR/upload.keystore.password")"; export APM_UPLOAD_STORE_PASSWORD
(cd android && ./gradlew --quiet assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64)
APK=android/app/build/outputs/apk/release/app-release.apk
PATH="$JAVA_HOME/bin:$PATH" "$ANDROID_HOME"/build-tools/37.0.0/apksigner verify --print-certs "$APK" | grep -q "certificate DN: CN=A Player Mode, O=Spry Labs" || { echo "APK is not signed with the upload key"; exit 1; }
mkdir -p ../../dist-android && cp "$APK" ../../dist-android/aplayermode.apk
echo "APK: dist-android/aplayermode.apk ($(du -h ../../dist-android/aplayermode.apk | cut -f1))"
