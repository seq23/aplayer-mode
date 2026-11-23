#!/usr/bin/env bash
# The paywall on the REAL store build, on an Android emulator (android-store-build.yml, capture job):
# signs the App Review account in, opens Settings > Plan at 320 and 390 dp wide, light then dark, and records it.
# Fails (Rule 0) unless every screenshot exists and scripts/android-capture-verdict.mjs passes each screen:
# Play prices with an enabled buy button, or the outage card with every buy button disabled and the
# cause the app logged (kept as billing-log.txt). No card checkout, no "not configured", no missing plan.
# usage: scripts/android-paywall-capture.sh <universal.apk> <out-dir>   (EMAIL and CODE in env)
set -euo pipefail
apk="$1"; out="$2"; flows="$(dirname "$0")/../apps/mobile/store/android-capture"
mkdir -p "$out"
signed_in=0
# Screen text is read here, never uploaded; on a failure after sign-in, the screen it stopped on is kept.
raw_log="$(mktemp)"; logcat_pid=""
trap 'rc=$?; [ -n "$logcat_pid" ] && kill "$logcat_pid" 2>/dev/null; [ "$rc" != 0 ] && [ "$signed_in" = 1 ] && adb exec-out screencap -p > "$out/failed-here.png"; rm -f "$out"/*.json "$raw_log"' EXIT
[ -n "${EMAIL:-}" ] && [ -n "${CODE:-}" ] || { echo "NAMED STOP [APM_REVIEW_SECRETS_MISSING] set APM_REVIEW_EMAIL and APM_REVIEW_CODE"; exit 1; }
adb wait-for-device
adb shell wm size 1170x2532 && adb shell wm density 480   # 3 px per dp: 960 px = 320 dp, 1170 px = 390 dp (sign-in at 390)
adb install -r "$apk"
# The app's own billing log (catalog.ts writes the store's error code) and RevenueCat's errors; only those lines are kept.
adb logcat -c; adb logcat -v brief 'ReactNativeJS:W' 'Purchases:W' '*:S' > "$raw_log" & logcat_pid=$!
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
    maestro hierarchy > "$out/$name-1.json"   # read by the verdict, never uploaded (it holds screen text)
    maestro test "$flows/store-card.yaml"
    adb exec-out screencap -p > "$out/$name-store.png"
    maestro hierarchy > "$out/$name-2.json"
    maestro test "$flows/buy-state.yaml"
    adb exec-out screencap -p > "$out/$name-buy.png"
    maestro hierarchy > "$out/$name-3.json"
    shots+=("$name")
  done
done
kill -INT "$rec" 2>/dev/null || true; sleep 3; adb pull /sdcard/paywall.mp4 "$out/paywall.mp4" || true
kill "$logcat_pid" 2>/dev/null || true; logcat_pid=""
grep -E '\[apm-billing\]|PurchasesError|BILLING_UNAVAILABLE|BillingResponse' "$raw_log" > "$out/billing-log.txt" || true
for name in "${shots[@]}"; do
  for f in "$out/$name.png" "$out/$name-store.png" "$out/$name-buy.png"; do [ -s "$f" ] || { echo "capture missing: $f"; exit 1; }; done
done
states="$(node "$(dirname "$0")/android-capture-verdict.mjs" "$out" "${shots[@]}")"
echo "OUTPUT android-paywall-capture: ${#shots[@]} screens (320+390 dp, light+dark); store side: $states"
