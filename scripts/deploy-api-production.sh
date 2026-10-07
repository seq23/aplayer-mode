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
