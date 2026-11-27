#!/usr/bin/env node
// THE APP REVIEW NOTES' EXECUTIVE SUITE STEPS, WALKED ON PRODUCTION (apps/mobile/store/app-review-notes.md,
// "Executive Suite and Autopilot" steps 1-2), with the one review account, through the same API calls the
// app makes. The web preview's sample server is not production; this is.
//
//   cd ~/GitHub/boss-os && npm run -s vault:run -- node ~/GitHub/aplayer-mode/scripts/review-walk.mjs [--approve]
//
// Reads the review code from APM_APPLE_REVIEW_PASSWORD (the vault entry; never printed, never an argument).
// Without --approve it stops once the card is seen (read-mostly: it signs in, records the notes' consents,
// level 4 and a morning score of 1, as the reviewer does). With --approve it taps Approve as well, which moves
// the review account's own sample task. It touches no other account.
// Prints one `WALK <step> <result>` line per step and nothing else; the last line is
// `WALK RESULT PASS` (exit 0) or `WALK RESULT NAMED STOP [<CODE>]` (exit 2). A network or server failure is
// a stop, never a pass.
const API = process.env.APM_API_URL ?? 'https://api.aplayermode.com';
const EMAIL = 'appreview@aplayermode.com';
const approve = process.argv.includes('--approve');
const say = (step, result) => console.log(`WALK ${step} ${result}`);
const stop = (code) => { say('RESULT', `NAMED STOP [${code}]`); process.exit(2); };

async function call(path, { token, method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { return { status: 0, json: {} }; }
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

export async function walk() {
  const code = process.env.APM_APPLE_REVIEW_PASSWORD;
  if (!code) stop('REVIEW_CODE_NOT_IN_ENV');
  const login = await call('/v1/auth/review-login', { method: 'POST', body: { email: EMAIL, code } });
  const token = login.json?.session?.access_token;
  say('sign-in', login.status === 200 && token ? 'ok' : `status ${login.status}`);
  if (!token) stop('REVIEW_SIGN_IN_FAILED');

  const consents = await call('/v1/consents', { token });
  if (consents.status !== 200) stop('CONSENTS_UNREADABLE');
  if (!consents.json.consents?.ageConfirmedAt) await call('/v1/consents/age', { token, method: 'POST', body: { confirmed: true } });
  const health = await call('/v1/consents/health-data', { token, method: 'POST', body: { decision: 'granted', policyVersion: consents.json.healthPolicyVersion } });
  say('18+ and "I agree"', health.status === 200 ? 'ok' : `status ${health.status}`);
  if (health.status !== 200) stop('HEALTH_CONSENT_FAILED');

  const level = await call('/v1/permissions/life_graph/plan_logistics', { token, method: 'PUT', body: { autonomyLevel: 4, constraints: {}, enabled: true } });
  say('"Goal checklists and task moves" at "4 · Approve & execute"', level.status === 200 ? `level ${level.json.permission?.autonomyLevel}` : `status ${level.status}`);
  if (level.status !== 200 || level.json.permission?.autonomyLevel !== 4) stop('PERMISSION_NOT_SET');

  const today = await call('/v1/today/check-in', { token, method: 'POST', body: { mood: 1 } });
  say('morning score 1, "Show my plan for today"', today.status === 200 ? (today.json.replayed ? 'ok (already checked in today)' : 'ok') : `status ${today.status} ${today.json.error ?? ''}`.trim());
  if (today.status !== 200) stop('CHECK_IN_FAILED');
  const card = (today.json.graph?.actions ?? []).find((a) => a.status === 'prepared' && a.payload?.suiteProposal === 'hard_day');
  say('"Take a task off today" card', card ? `shown, Approve ${card.approvalAvailable ? 'offered' : 'NOT offered (Prepare only)'}` : 'not shown');
  if (!card) stop('SUITE_CARD_MISSING');
  if (!card.approvalAvailable) stop('APPROVE_NOT_OFFERED');
  if (!approve) { say('RESULT', 'PASS (card with Approve; run with --approve to tap it)'); return; }

  const done = await call(`/v1/actions/${encodeURIComponent(card.id)}/approve`, { token, method: 'POST' });
  say('"Approve"', done.status === 200 ? `action ${done.json.action?.status}` : `status ${done.status} ${done.json.error ?? ''}`.trim());
  if (done.status !== 200 || done.json.action?.status !== 'verified') stop('APPROVE_FAILED');
  say('RESULT', 'PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) await walk();
