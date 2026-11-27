// scripts/review-walk.mjs walks the App Review notes' Executive Suite steps on production. It must end
// PASS only when the card is there with Approve offered (and, with --approve, verified), stop by name on
// anything else, an outage included, and never print the review code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/review-walk.mjs', import.meta.url));
const CODE = 'q7Rt2Wx9Lm4Np8Zs';
const card = (approvalAvailable) => ({ id: 'a1', status: 'prepared', approvalAvailable, payload: { suiteProposal: 'hard_day' } });

async function run(routes, args = []) {
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    const hit = routes[key];
    res.writeHead(hit ? hit[0] : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit ? hit[1] : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, APM_API_URL: `http://127.0.0.1:${server.address().port}`, APM_APPLE_REVIEW_PASSWORD: CODE } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const status = await new Promise((r) => child.on('close', r));
  server.close();
  return { status, out };
}
const happy = (actions) => ({
  'POST /v1/auth/review-login': [200, { review: true, session: { access_token: 't', refresh_token: 'r' } }],
  'GET /v1/consents': [200, { consents: { ageConfirmedAt: '2026-11-27T00:00:00Z' }, healthPolicyVersion: '2026-10-08' }],
  'POST /v1/consents/health-data': [200, {}],
  'PUT /v1/permissions/life_graph/plan_logistics': [200, { permission: { autonomyLevel: 4 } }],
  'POST /v1/today/check-in': [200, { replayed: false, graph: { actions } }],
  'POST /v1/actions/a1/approve': [200, { action: { status: 'verified' } }],
});

test('the walk passes only on the card with Approve, and --approve only on a verified move', async () => {
  const pass = await run(happy([card(true)]), ['--approve']);
  assert.equal(pass.status, 0, pass.out);
  assert.match(pass.out, /WALK "Approve" action verified\nWALK RESULT PASS\n$/);
  for (const [actions, stopCode] of [[[], 'SUITE_CARD_MISSING'], [[card(false)], 'APPROVE_NOT_OFFERED']]) {
    const r = await run(happy(actions), ['--approve']);
    assert.equal(r.status, 2);
    assert.match(r.out, new RegExp(`NAMED STOP \\[${stopCode}\\]`));
  }
});

test('an outage or a refused sign-in is a named stop, never a pass, and the code is never printed', async () => {
  const down = await run({});
  assert.equal(down.status, 2);
  assert.match(down.out, /NAMED STOP \[REVIEW_SIGN_IN_FAILED\]/);
  const routes = happy([card(true)]);
  routes['POST /v1/actions/a1/approve'] = [503, { error: 'unavailable' }];
  const broken = await run(routes, ['--approve']);
  assert.equal(broken.status, 2);
  assert.match(broken.out, /NAMED STOP \[APPROVE_FAILED\]/);
  for (const r of [down, broken]) assert.ok(!r.out.includes(CODE));
});
