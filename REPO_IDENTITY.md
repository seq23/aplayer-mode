# Repository Identity

- **Repository:** `seq23/aplayer-mode`
- **Expected root name:** `aplayer-mode`
- **Repository class:** product monorepo — Expo app, Cloudflare Worker API, shared packages
- **Primary branch:** `main`
- **Public domains:** `app.aplayermode.com` (the web app, `apps/mobile`), `api.aplayermode.com` (the API Worker, `services/api`)
- **Brand domain served elsewhere:** `aplayermode.com` — the marketing front door's pages live in `sprylabs-hpc-site`; a fix to that host belongs in that repository, not this one. It is measured here (`config/outcome-sites.json`) so a drop is seen, and the issue the weekly report opens names where the fix lives.
- **Package manager:** npm using `package-lock.json`, workspaces `apps/*`, `packages/*`, `services/*`
- **Node authority:** Node 22.13.0
- **Mobile distribution:** Expo EAS to Apple and Google; Cloudflare never distributes binaries
- **Identity and data platform:** Supabase; Cloudflare is the API, intelligence, privacy and action boundary
- **Deploy paths:** `scripts/deploy-web-production.sh`, `scripts/deploy-api-production.sh`, and the dispatch-only `.github/workflows/deploy-cloudflare.yml`. Never a bare `wrangler deploy` by hand.

## Authority

- `AGENTS.md` — the agent brief: authority order, product identity, non-negotiable rules.
- `CLAUDE.md` — cost ("nothing paid"), the pre-push batched check, deployment.
- `docs/` — LOCKED constitutions and specifications; `docs/21-FULL-PROGRAM-EXECUTION-LEDGER.md` is current program authority.
- `docs/cost/zero-paid-llm.md` — the model-cost rule, enforced by `npm run validate:cost`.

## Weekly outcome

`.github/workflows/weekly-outcome-report.yml` (Mondays 08:00 America/Chicago) measures every host in `config/outcome-sites.json` week over week, commits `reports/outcomes/<ISO-week>.{json,md}`, and opens one self-closing issue per red host.
