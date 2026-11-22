#!/usr/bin/env bash
# The paywall on the REAL store build, on an Android emulator (android-store-build.yml, capture job):
# signs the App Review account in, opens Settings > Plan at 320 and 390 dp wide, light then dark, and records it.
# Fails (Rule 0) unless every screenshot exists, the tier cards rendered, the store side settled to either
# Play prices (buy buttons live) or the outage card, and no card checkout appears.
# usage: scripts/android-paywall-capture.sh <universal.apk> <out-dir>   (EMAIL and CODE in env)
set -euo pipefail
apk="$1"; out="$2"; flows="$(dirname "$0")/../apps/mobile/store/android-capture"
mkdir -p "$out"
signed_in=0
# Screen text is read here, never uploaded; on a failure after sign-in, the screen it stopped on is kept.
trap 'rc=$?; [ "$rc" != 0 ] && [ "$signed_in" = 1 ] && adb exec-out screencap -p > "$out/failed-here.png"; rm -f "$out"/*.json' EXIT
[ -n "${EMAIL:-}" ] && [ -n "${CODE:-}" ] || { echo "NAMED STOP [APM_REVIEW_SECRETS_MISSING] set APM_REVIEW_EMAIL and APM_REVIEW_CODE"; exit 1; }
adb wait-for-device
adb shell wm size 1170x2532 && adb shell wm density 480   # 3 px per dp: 960 px = 320 dp, 1170 px = 390 dp (sign-in at 390)
adb install -r "$apk"
maestro test -e EMAIL="$EMAIL" -e CODE="$CODE" "$flows/sign-in.yaml"
signed_in=1
adb shell screenrecord --time-limit 180 /sdcard/paywall.mp4 & rec=$!
flows="$(cd "$flows" && pwd)"
shots=()
for dp in 320 390; do
  adb shell wm size "$((dp * 3))x2532"
  for mode in no yes; do
    adb shell cmd uimode night "$mode"
    name="paywall-$dp-$([ "$mode" = no ] && echo light || echo dark)"
    maestro test "$flows/paywall.yaml"
    adb exec-out screencap -p > "$out/$name.png"
    maestro hierarchy > "$out/$name.json"   # read below, never uploaded (it holds screen text)
    maestro test "$flows/store-card.yaml"
    adb exec-out screencap -p > "$out/$name-store.png"
    maestro hierarchy >> "$out/$name.json"
    maestro test "$flows/buy-state.yaml"
    adb exec-out screencap -p > "$out/$name-buy.png"
    maestro hierarchy >> "$out/$name.json"
    shots+=("$name")
  done
done
kill -INT "$rec" 2>/dev/null || true; sleep 3; adb pull /sdcard/paywall.mp4 "$out/paywall.mp4" || true
states=()
for name in "${shots[@]}"; do
  for f in "$out/$name.png" "$out/$name-store.png" "$out/$name-buy.png"; do [ -s "$f" ] || { echo "capture missing: $f"; exit 1; }; done
  h="$out/$name.json"
  grep -q 'Executive Roundtable' "$h" || { echo "$name: tier cards never rendered"; exit 1; }
  if grep -qiE 'pay by card|Plans are paid by card' "$h"; then echo "$name: store build shows card checkout"; exit 1; fi
  if grep -q 'Getting prices from the store' "$h"; then echo "$name: still loading store prices"; exit 1; fi
  if grep -q 'Google Play is not answering right now' "$h"; then
    grep -q 'Not available right now' "$h" || { echo "$name: outage card shown but a buy button is live"; exit 1; }
    states+=("$name=outage")
  else
    grep -q 'Not available right now' "$h" && { echo "$name: buy blocked with no outage card"; exit 1; }
    states+=("$name=play-prices")
  fi
done
echo "OUTPUT android-paywall-capture: ${#shots[@]} screens (320+390 dp, light+dark), tier cards rendered, no card checkout; store side: ${states[*]}"
