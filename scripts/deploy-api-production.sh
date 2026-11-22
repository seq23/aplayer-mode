#!/usr/bin/env bash
# Deploys services/api to the production Worker (aplayer-mode-api, api.aplayermode.com) the same
# way .github/workflows/deploy-cloudflare.yml does: typecheck + tests, then `wrangler deploy
# --env production` with the build SHA and environment defines, then the health check.
# Never run a bare `wrangler deploy` (it would ship the top-level, unnamed environment).
#
#   scripts/deploy-api-production.sh [--secrets-dir DIR]
#
# --secrets-dir: a directory of 0600 files named after Worker secrets (OPENROUTER_API_KEY,
# CONNECTOR_CREDENTIAL_KEY, REVENUECAT_WEBHOOK_SECRET, APP_REVIEW_CODE,
# SUPABASE_SECRET_KEY, ...). Each is piped to `wrangler secret put` from the file, so no value is
# printed or put on a command line. BILLING_ALLOW_SANDBOX is refused in production.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
SECRETS_DIR=""
[ "${1:-}" = "--secrets-dir" ] && SECRETS_DIR="${2:?--secrets-dir needs a path}"
SHA=$(git rev-parse HEAD)
git diff --quiet HEAD -- services packages || { echo "refusing: uncommitted changes under services/ or packages/ (the health SHA would lie)"; exit 2; }
# `a && b` does not stop under set -e when `a` fails, so each step exits on its own failure.
npm run typecheck >/dev/null || exit 2
npm run test >/dev/null || exit 2
# Migrations next (after the tests, before wrangler): a Worker deployed before its migration
# breaks the routes that need it (the 0107 outage, 21 Nov 2026). Applies every repo migration not yet in the Supabase ledger, in order, and
# refuses (exit 2) on any doubt; see the header of scripts/db-migrations.mjs.
node scripts/db-migrations.mjs || exit 2
cd services/api
npx wrangler deploy --env production \
  --define "__APM_BUILD_SHA__:'${SHA}'" \
  --define "__APM_RUNTIME_ENVIRONMENT__:'production'"
if [ -n "$SECRETS_DIR" ]; then
  for file in "$SECRETS_DIR"/*; do
    name=$(basename "$file")
    case "$name" in
      BILLING_ALLOW_SANDBOX) echo "refusing $name in production"; exit 2 ;;
      APP_REVIEW_EMAIL|*.*) continue ;;   # a var in wrangler.jsonc, or not a secret file
    esac
    [[ "$name" =~ ^[A-Z][A-Z0-9_]+$ ]] || continue
    # Only names the Worker declares (ApiEnv in src/env.ts): the secrets dir also holds operator
    # keys (RC_V2_SECRET_KEY, STRIPE_TEST_*) that must never reach the Worker.
    grep -qE "^[[:space:]]+${name}\??:" src/env.ts || { echo "skipped (not a Worker env name): $name"; continue; }
    npx wrangler secret put "$name" --env production < "$file" >/dev/null
    echo "secret set: $name"
  done
fi
# The annual renewal reminder (renewalReminders.ts) needs its sending key; without it every due
# reminder is a NAMED STOP in the Worker log, so say it here too, where a person is watching.
npx wrangler secret list --env production 2>/dev/null | grep -q '"RESEND_API_KEY"' || echo "NAMED STOP [RENEWAL_EMAIL_KEY_MISSING] set RESEND_API_KEY (Resend sending key for mail.aplayermode.com) with --secrets-dir"
for attempt in $(seq 1 12); do
  body=$(curl -sS --max-time 20 https://api.aplayermode.com/v1/health || true)
  if node -e "const b=JSON.parse(process.argv[1]||'{}');process.exit(b.ok===true&&b.buildSha===process.argv[2]&&b.runtimeEnvironment==='production'?0:1)" "$body" "$SHA" 2>/dev/null; then
    echo "health PASS: production at $SHA"; exit 0
  fi
  sleep 5
done
echo "health FAIL: https://api.aplayermode.com/v1/health did not report $SHA"; exit 1
