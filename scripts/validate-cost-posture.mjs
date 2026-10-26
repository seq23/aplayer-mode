#!/usr/bin/env node
// "Nothing paid" made executable (Search Readiness Checklist i10).
// Reads docs/cost/zero-paid-llm.md and CLAUDE.md, then checks the code still obeys them:
//
//   1. CLAUDE.md carries the rule in words ("nothing paid") and points at the document;
//      the document exists and still states each clause this script enforces.
//   2. No workflow that runs on a schedule, on push or on pull_request references a
//      model-provider key — repository automation makes no model call at all.
//   3. Every modelId in the `defaults` route set of scripts/evaluate-openrouter-routes.mjs
//      ends in ':free', so a dispatch with no inputs costs nothing.
//   4. Every route in COACHING_CANDIDATE_ROUTES declares both a costClass and a
//      pricePerMTok, so no route can be priced silently.
//
// Rule 0: it never passes having checked nothing. No workflows found, no default routes
// found, or no candidate routes found is a failure, not a pass.
//
// Usage: node scripts/validate-cost-posture.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOC = 'docs/cost/zero-paid-llm.md';
const PROVIDER_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY'];
/** Clauses the document must still state; the check below enforces each one. */
const DOC_CLAUSES = [
  [/nothing paid/i, 'the rule itself ("nothing paid")'],
  [/schedule|scheduled/i, 'that scheduled automation makes no model call'],
  [/APM_EVAL_ROUTES_JSON/, 'that a priced route is reachable only through APM_EVAL_ROUTES_JSON'],
  [/:free/, 'that the default evaluation route set is :free only'],
  [/named\s+stop/i, 'that a failed free route is a named stop, not a paid fallback'],
];

const read = async (path) => { try { return await readFile(join(root, path), 'utf8'); } catch { return null; } };
const violations = [];

// ─── 1. the rule in words, where an agent and the owner can read it ──────────
const claudeMd = await read('CLAUDE.md');
if (claudeMd === null) violations.push('CLAUDE.md is missing — the "nothing paid" rule has nowhere to live');
else {
  if (!/nothing paid/i.test(claudeMd)) violations.push('CLAUDE.md does not say "nothing paid"');
  if (!claudeMd.includes(DOC)) violations.push(`CLAUDE.md does not point at ${DOC}`);
}
const doc = await read(DOC);
if (doc === null) violations.push(`${DOC} is missing`);
else for (const [pattern, what] of DOC_CLAUSES) {
  if (!pattern.test(doc)) violations.push(`${DOC} no longer states ${what}`);
}

// ─── 2. automation makes no model call ───────────────────────────────────────
let workflows = [];
try {
  const names = (await readdir(join(root, '.github/workflows'))).filter((n) => /\.ya?ml$/.test(n));
  for (const name of names) workflows.push({ name, text: (await read(`.github/workflows/${name}`)) ?? '' });
} catch { /* reported as zero below */ }
if (!workflows.length) violations.push('no workflows found under .github/workflows — refusing to pass on nothing');
let automated = 0;
for (const workflow of workflows) {
  // The trigger block is everything before the first top-level key after `on:`.
  const on = /^on:\s*$[\s\S]*?(?=^\w)/m.exec(workflow.text)?.[0] ?? /^on:.*$/m.exec(workflow.text)?.[0] ?? '';
  const runsByItself = /^\s+(schedule|push|pull_request):/m.test(on);
  if (!runsByItself) continue;
  automated += 1;
  for (const key of PROVIDER_KEYS) {
    if (workflow.text.includes(key)) violations.push(`${workflow.name} runs by itself (schedule/push/pull_request) and references ${key} — automation makes no model call`);
  }
}
if (!automated) violations.push('no workflow runs on a schedule, push or pull_request — expected at least CI, so this check is looking at nothing');

// ─── 3. the default evaluation route set is free ─────────────────────────────
const evalScript = await read('scripts/evaluate-openrouter-routes.mjs');
if (evalScript === null) violations.push('scripts/evaluate-openrouter-routes.mjs is missing');
else {
  const block = /const defaults = \[([\s\S]*?)\];/.exec(evalScript)?.[1];
  if (!block) violations.push('scripts/evaluate-openrouter-routes.mjs: could not find the `defaults` route set — the free-by-default rule cannot be checked');
  else {
    const ids = [...block.matchAll(/modelId:\s*'([^']+)'/g)].map((m) => m[1]);
    if (!ids.length) violations.push('scripts/evaluate-openrouter-routes.mjs: `defaults` declares no modelId');
    for (const id of ids) if (!id.endsWith(':free')) violations.push(`scripts/evaluate-openrouter-routes.mjs: default route ${id} is not a :free model — name a priced route in APM_EVAL_ROUTES_JSON at dispatch instead`);
  }
}

// ─── 4. no route is priced silently ──────────────────────────────────────────
const cases = await read('scripts/coaching-eval-cases.mjs');
if (cases === null) violations.push('scripts/coaching-eval-cases.mjs is missing');
else {
  const block = /COACHING_CANDIDATE_ROUTES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(cases)?.[1];
  if (!block) violations.push('scripts/coaching-eval-cases.mjs: could not find COACHING_CANDIDATE_ROUTES');
  else {
    const routes = block.split(/\n\s*\{/).slice(1);
    if (!routes.length) violations.push('scripts/coaching-eval-cases.mjs: COACHING_CANDIDATE_ROUTES is empty');
    for (const route of routes) {
      const id = /modelId:\s*'([^']+)'/.exec(route)?.[1] ?? 'an unnamed route';
      if (!/costClass:/.test(route)) violations.push(`scripts/coaching-eval-cases.mjs: ${id} declares no costClass`);
      if (!/pricePerMTok:/.test(route)) violations.push(`scripts/coaching-eval-cases.mjs: ${id} declares no pricePerMTok — a route may not be priced silently`);
    }
  }
}

if (violations.length) {
  console.error(`validate:cost FAILED — ${violations.length} violation(s) of ${DOC}:`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(`validate:cost passed: CLAUDE.md and ${DOC} state the rule; ${automated} self-running workflow(s) hold no provider key; the default evaluation routes are :free only; every candidate route declares its price.`);
