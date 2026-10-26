# CLAUDE.md — A Player Mode

`AGENTS.md` is the agent brief for this repository: authority order, product identity and the
non-negotiable rules. Read it first; everything there applies here. This file adds only what an
agent has to know before it spends anything or ships anything.

## Cost: nothing paid

**Nothing paid.** No scheduled or CI-triggered workflow in this repository may make a paid model
call — or any model call. Model evaluation is dispatch-only and its default route set is `:free`
models only; a priced route is reachable only by naming it in `APM_EVAL_ROUTES_JSON` at dispatch.
A free route that fails is a named stop, never a silent upgrade to a billed model.

The rule, what it does not govern (the product's own cost of goods is a settled decision with its
own key and cap), and how to add a route are in **`docs/cost/zero-paid-llm.md`**.

This is not a convention. `npm run validate:cost` reads both this file and that document and
fails the build when the code stops obeying them; CI runs it on every pull request.

## Before you push

One batched call:

```
npm run typecheck && npm run test && npm run presubmit:ios && npm run validate:cost && npm run validate:outcomes
```

`validate:outcomes` self-checks the weekly outcome report
(`.github/workflows/weekly-outcome-report.yml`, Mondays 08:00 America/Chicago): it measures every
host in `config/outcome-sites.json` week over week, commits
`reports/outcomes/<ISO-week>.{json,md}`, and opens one self-closing issue per red host. Adding a
host is one entry in that config file.

## Deploying

Deployment is a script, never a bare `wrangler deploy` by hand (a bare deploy ships a stale
client): `scripts/deploy-web-production.sh` for the web app, `scripts/deploy-api-production.sh`
for the API. Nothing deploys on a push or a schedule — the one workflow that deploys,
`.github/workflows/deploy-cloudflare.yml`, is `workflow_dispatch` only, takes the environment as
an input and writes a deployment receipt. `docs/14-DEPLOYMENT-AND-SECRETS.md` is the authority
for all three.
