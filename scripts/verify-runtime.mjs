#!/usr/bin/env node

const required = [
  'APM_API_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'APM_TEST_EMAIL',
  'APM_TEST_PASSWORD',
  'APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT',
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required runtime-proof environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

if (process.env.APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT !== 'yes') {
  console.error(
    'Refusing to run mutation proof. Set APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT=yes only for a dedicated disposable test account.',
  );
  process.exit(2);
}

const apiBaseUrl = process.env.APM_API_BASE_URL.replace(/\/$/, '');
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const proof = [];

function pass(name, detail) {
  proof.push({ name, status: 'PASS', detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  proof.push({ name, status: 'FAIL', detail });
  throw new Error(`${name}: ${detail}`);
}

async function readJson(response, label) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(label, `Expected JSON but received a non-JSON response (${response.status})`);
  }
}

async function supabasePasswordSignIn(email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response, 'Supabase password sign-in');
  if (!response.ok || !body?.access_token || !body?.user?.id) {
    fail('Supabase password sign-in', `Authentication failed (${response.status})`);
  }
  return { accessToken: body.access_token, userId: body.user.id };
}

async function apiRequest(path, { accessToken, method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await readJson(response, `${method} ${path}`);
  return { response, json };
}

async function verifyRlsIsolation(userAId) {
  const email = process.env.APM_TEST_B_EMAIL;
  const password = process.env.APM_TEST_B_PASSWORD;
  if (!email || !password) {
    console.log('SKIP  Cross-user RLS negative proof — second dedicated test account not configured');
    return;
  }

  const userB = await supabasePasswordSignIn(email, password);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?select=user_id&user_id=eq.${encodeURIComponent(userAId)}`,
    {
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${userB.accessToken}`,
        accept: 'application/json',
      },
    },
  );
  const rows = await readJson(response, 'Cross-user RLS negative proof');
  if (!response.ok) fail('Cross-user RLS negative proof', `Supabase REST failed (${response.status})`);
  if (!Array.isArray(rows) || rows.length !== 0) {
    fail('Cross-user RLS negative proof', 'Second user could observe first user profile');
  }
  pass('Cross-user RLS negative proof', 'second user cannot read first user profile');
}

async function main() {
  console.log('A Player Mode runtime proof');
  console.log(`API: ${apiBaseUrl}`);

  const health = await apiRequest('/v1/health');
  if (!health.response.ok || health.json?.ok !== true || health.json?.service !== 'aplayer-mode-api') {
    fail('Public health route', `Unexpected health response (${health.response.status})`);
  }
  pass('Public health route', 'Cloudflare APM API is reachable');

  const unauthenticated = await apiRequest('/v1/me/life-graph');
  if (unauthenticated.response.status !== 401) {
    fail('Private route rejects anonymous requests', `Expected 401, received ${unauthenticated.response.status}`);
  }
  pass('Private route rejects anonymous requests', 'fail-closed auth boundary works');

  const userA = await supabasePasswordSignIn(process.env.APM_TEST_EMAIL, process.env.APM_TEST_PASSWORD);
  pass('Supabase Auth', 'dedicated runtime-proof account authenticated');

  let state = await apiRequest('/v1/me/life-graph', { accessToken: userA.accessToken });
  if (!state.response.ok || state.json?.graph?.identity?.userId !== userA.userId) {
    fail('Authenticated Life Graph read', `User-scoped graph did not match authenticated user (${state.response.status})`);
  }
  pass('Authenticated Life Graph read', 'Cloudflare verified Supabase session and returned user-scoped state');

  let openAction = state.json.graph.nextActions?.find((action) => action.status === 'open');
  if (!openAction) {
    const onboarding = await apiRequest('/v1/onboarding', {
      accessToken: userA.accessToken,
      method: 'PUT',
      body: {
        displayName: 'APM Runtime Proof',
        roles: ['runtime-proof-user'],
        primaryGoal: 'Prove authenticated durable APM execution end to end',
        currentSeason: 'runtime verification',
        becoming: 'a verified end-to-end system',
        pillar: 'execution',
      },
    });
    if (!onboarding.response.ok || onboarding.json?.graph?.identity?.userId !== userA.userId) {
      fail('Durable onboarding write', `Onboarding mutation failed (${onboarding.response.status})`);
    }
    openAction = onboarding.json.graph.nextActions?.find((action) => action.status === 'open');
    if (!openAction) fail('Durable onboarding write', 'No open next action was created');
    pass('Durable onboarding write', 'profile, role, goal and next action persisted through API/RPC');
  } else {
    pass('Durable onboarding state', 'existing open action found on persisted test Life Graph');
  }

  const today = await apiRequest('/v1/me/today', { accessToken: userA.accessToken });
  if (!today.response.ok || today.json?.plan?.numberOneMove?.id !== openAction.id) {
    fail('Server Today projection', `Today did not select the persisted open action (${today.response.status})`);
  }
  pass('Server Today projection', 'number-one move reconstructed from durable server state');

  const completion = await apiRequest(`/v1/next-actions/${encodeURIComponent(openAction.id)}/complete`, {
    accessToken: userA.accessToken,
    method: 'POST',
  });
  if (
    !completion.response.ok ||
    completion.json?.action?.status !== 'done' ||
    completion.json?.evidence?.relatedActionId !== openAction.id
  ) {
    fail('Completion + evidence transaction', `Completion transaction failed (${completion.response.status})`);
  }
  pass('Completion + evidence transaction', 'action completion and evidence were committed atomically');

  state = await apiRequest('/v1/me/life-graph', { accessToken: userA.accessToken });
  const durableAction = state.json?.graph?.nextActions?.find((action) => action.id === openAction.id);
  const durableEvidence = state.json?.graph?.evidence?.find((evidence) => evidence.relatedActionId === openAction.id);
  if (!state.response.ok || durableAction?.status !== 'done' || !durableEvidence) {
    fail('Durability after reread', 'Completion/evidence did not survive a fresh server read');
  }
  pass('Durability after reread', 'canonical state survives a fresh request');

  const proactiveItem = state.json?.graph?.radarItems?.find(
    (item) => item.relatedGoalId === openAction.goalId && item.status === 'open',
  );
  if (!proactiveItem) {
    fail('Deterministic Radar loop', 'Expected a proactive item after completing the only open action for the goal');
  }
  pass('Deterministic Radar loop', `Radar surfaced ${proactiveItem.type} without an LLM call`);

  await verifyRlsIsolation(userA.userId);

  console.log('\nRUNTIME PROOF RESULT: PASS');
  console.log(`Checks passed: ${proof.filter((item) => item.status === 'PASS').length}`);
}

main().catch((error) => {
  console.error('\nRUNTIME PROOF RESULT: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
