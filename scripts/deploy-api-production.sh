#!/usr/bin/env bash
# Deploys services/api to the production Worker (aplayer-mode-api, api.aplayermode.com) the same
# way .github/workflows/deploy-cloudflare.yml does: typecheck + tests, then `wrangler deploy
# --env production` with the build SHA and environment defines, then the health check.
# Never run a bare `wrangler deploy` (it would ship the top-level, unnamed environment).
#
#   scripts/deploy-api-production.sh [--secrets-dir DIR]
#
# --secrets-dir: a directory of 0600 files named after Worker secrets (OPENROUTER_API_KEY,
# CONNECTOR_CREDENTIAL_KEY, OAUTH_STATE_SECRET, REVENUECAT_WEBHOOK_SECRET, APP_REVIEW_CODE,
# SUPABASE_SECRET_KEY, ...). Each is piped to `wrangler secret put` from the file, so no value is
# printed or put on a command line. BILLING_ALLOW_SANDBOX is refused in production.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
SECRETS_DIR=""
[ "${1:-}" = "--secrets-dir" ] && SECRETS_DIR="${2:?--secrets-dir needs a path}"
SHA=$(git rev-parse HEAD)
git diff --quiet HEAD -- services packages || { echo "refusing: uncommitted changes under services/ or packages/ (the health SHA would lie)"; exit 2; }
# Migrations first (RUNBOOK): every account route calls these database functions, so a Worker
# deployed before its migration answers 500 everywhere. PostgREST answers 404 for a function that
# does not exist and 401 for one the anonymous key may not run, so this probe changes nothing.
# Add the entry point of each new migration the Worker depends on.
REQUIRED_RPCS="apm_my_consents apm_record_consent apm_service_carry_consents apm_service_day_check_in_v2"
SB_URL=$(node -e "const t=require('fs').readFileSync('services/api/wrangler.jsonc','utf8');process.stdout.write((t.match(/\"SUPABASE_URL\": \"([^\"]+)\"/)||[])[1]||'')")
SB_KEY=$(node -e "const t=require('fs').readFileSync('services/api/wrangler.jsonc','utf8');process.stdout.write((t.match(/\"SUPABASE_PUBLISHABLE_KEY\": \"([^\"]+)\"/)||[])[1]||'')")
[ -n "$SB_URL" ] && [ -n "$SB_KEY" ] || { echo "refusing: no SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY in services/api/wrangler.jsonc"; exit 2; }
for fn in $REQUIRED_RPCS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$SB_URL/rest/v1/rpc/$fn" -H "apikey: $SB_KEY" -H 'content-type: application/json' -d '{}')
  [ "$code" = "404" ] && { echo "refusing: database function $fn is missing; apply services/api/migrations in order first (RUNBOOK → Deploy)"; exit 2; }
  [ "$code" = "000" ] && { echo "refusing: Supabase did not answer the migration probe for $fn"; exit 2; }
done
npm run typecheck >/dev/null && npm run test >/dev/null
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
for attempt in $(seq 1 12); do
  body=$(curl -sS --max-time 20 https://api.aplayermode.com/v1/health || true)
  if node -e "const b=JSON.parse(process.argv[1]||'{}');process.exit(b.ok===true&&b.buildSha===process.argv[2]&&b.runtimeEnvironment==='production'?0:1)" "$body" "$SHA" 2>/dev/null; then
    echo "health PASS: production at $SHA"; exit 0
  fi
  sleep 5
done
echo "health FAIL: https://api.aplayermode.com/v1/health did not report $SHA"; exit 1
