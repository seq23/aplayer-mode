# CLAUDE.md — A Player Mode

`AGENTS.md` is the agent brief for this repository: authority order, product identity and the
non-negotiable rules. Read it first; everything there applies here. This file adds only what an
agent has to know before it spends anything or ships anything.

## Company brain

Read `~/Brains/spry.md` before any work (business facts, priorities, voice, settled decisions). New business facts go to the brain via Boss OS, not into this repo or memory. Repo how-tos stay in `docs/`.

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
(`.github/workflows/weekly-outcome-report.yml`, Wednesdays 07:13 America/Chicago; no email of its own, its summary goes to Boss OS for the one Spry Labs weekly email): it measures every
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

## Her look at a build

Every build of the phone app gets a free web preview: `.github/workflows/app-preview.yml` exports
`apps/mobile` in preview mode (`EXPO_PUBLIC_APM_PREVIEW=1`: sample data from
`apps/mobile/src/preview/server.ts`, no real sign-in, no purchase, no call to the production API)
and publishes it to the Pages project `aplayer-mode-app-preview`. Main is always at
https://aplayer-mode-app-preview.pages.dev; a pull request gets its own link in a comment. That
project is a preview, not the product. Appetize is only her final look before a store submission:
start `.github/workflows/preview.yml` by hand with "appetize" ticked. Agents never spend Appetize
minutes.
