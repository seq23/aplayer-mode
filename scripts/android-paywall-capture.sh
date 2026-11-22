#!/usr/bin/env bash
# The paywall on the REAL store build, on an Android emulator (android-store-build.yml, capture job):
# signs the App Review account in, opens Settings > Plan at 390 dp wide, light then dark, and records it.
# Fails (Rule 0) unless both screenshots exist and the paywall shows no card checkout.
# usage: scripts/android-paywall-capture.sh <universal.apk> <out-dir>   (EMAIL and CODE in env)
set -euo pipefail
apk="$1"; out="$2"; flows="$(dirname "$0")/../apps/mobile/store/android-capture"
mkdir -p "$out"
signed_in=0
# Screen text is read here, never uploaded; on a failure after sign-in, the screen it stopped on is kept.
trap 'rc=$?; [ "$rc" != 0 ] && [ "$signed_in" = 1 ] && adb exec-out screencap -p > "$out/failed-here.png"; rm -f "$out"/*.json' EXIT
[ -n "${EMAIL:-}" ] && [ -n "${CODE:-}" ] || { echo "NAMED STOP [APM_REVIEW_SECRETS_MISSING] set APM_REVIEW_EMAIL and APM_REVIEW_CODE"; exit 1; }
adb wait-for-device
adb shell wm size 1170x2532 && adb shell wm density 480   # 1170 px / 3 = 390 dp
adb install -r "$apk"
maestro test -e EMAIL="$EMAIL" -e CODE="$CODE" "$flows/sign-in.yaml"
signed_in=1
adb shell screenrecord --time-limit 170 /sdcard/paywall.mp4 & rec=$!
flows="$(cd "$flows" && pwd)"
for mode in no yes; do
  adb shell cmd uimode night "$mode"
  name=$([ "$mode" = no ] && echo light || echo dark)
  (cd "$out" && maestro test -e MODE="$name" "$flows/paywall.yaml")
  mv "$flows"/paywall-390-*.png "$out"/ 2>/dev/null || true   # Maestro versions differ on where takeScreenshot writes
  maestro hierarchy > "$out/paywall-390-$name.json"   # read below, never uploaded (it holds screen text)
done
kill -INT "$rec" 2>/dev/null || true; sleep 3; adb pull /sdcard/paywall.mp4 "$out/paywall.mp4" || true
for f in "$out"/paywall-390-light.png "$out"/paywall-390-dark.png; do [ -s "$f" ] || { echo "capture missing: $f"; exit 1; }; done
if grep -qiE 'pay by card|Plans are paid by card' "$out"/paywall-390-*.json; then echo "store build shows card checkout"; exit 1; fi
state=$(grep -oE 'Google Play is not answering right now|[$][0-9]+\.[0-9]{2}/month' "$out/paywall-390-light.json" | sort -u | tr '\n' ';')
echo "OUTPUT android-paywall-capture: light+dark at 390 dp, no card checkout; store side: ${state:-none}"
