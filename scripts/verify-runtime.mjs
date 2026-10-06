#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const required = [
  'APM_API_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'APM_TEST_EMAIL',
  'APM_TEST_PASSWORD',
  'APM_TEST_B_EMAIL',
  'APM_TEST_B_PASSWORD',
  'APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT',
];

const expectedCommitSha = process.env.APM_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '';
const outputPath = resolve(process.env.APM_RUNTIME_PROOF_OUTPUT ?? 'evidence/runtime-proof.json');
const proof = [];
let apiBaseUrl = process.env.APM_API_BASE_URL?.replace(/\/$/, '') ?? '';
let supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '') ?? '';
let currentStage = 'configuration';
let remoteBuildSha = null;

async function writeReceipt(status, error) {
  await mkdir(dirname(outputPath), { recursive: true });
  const receipt = {
    schemaVersion: 1,
    gate: 'live_runtime',
    status,
    generatedAt: new Date().toISOString(),
    commitSha: expectedCommitSha || null,
    remoteBuildSha,
    buildShaMatchesExpected: remoteBuildSha ? remoteBuildSha === expectedCommitSha : null,
    environment: process.env.APM_RUNTIME_ENVIRONMENT ?? 'unspecified',
    apiBaseUrl: apiBaseUrl || null,
    supabaseHost: supabaseUrl ? new URL(supabaseUrl).host : null,
    dedicatedTestAccounts: 2,
    stage: currentStage,
    checks: proof,
    error: error ? String(error instanceof Error ? error.message : error).slice(0, 1000) : null,
    sensitiveValuesRecorded: false,
  };
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`Evidence receipt: ${outputPath}`);
}

function pass(name, detail, metadata = {}) {
  proof.push({ name, status: 'PASS', detail, ...metadata });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail, metadata = {}) {
  proof.push({ name, status: 'FAIL', detail, ...metadata });
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

async function supabasePasswordSignIn(email, password, label) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response, label);
  if (!response.ok || !body?.access_token || !body?.user?.id) {
    fail(label, `Authentication failed (${response.status})`);
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
  return { response, json, requestId: response.headers.get('x-request-id') };
}

async function supabaseRows(path, accessToken, label) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  const rows = await readJson(response, label);
  if (!response.ok) fail(label, `Supabase REST failed (${response.status})`);
  if (!Array.isArray(rows)) fail(label, 'Supabase REST did not return an array');
  return rows;
}

async function verifyRlsIsolation(userAId, goalAId) {
  currentStage = 'rls_isolation';
  const userB = await supabasePasswordSignIn(
    process.env.APM_TEST_B_EMAIL,
    process.env.APM_TEST_B_PASSWORD,
    'Second Supabase test-account sign-in',
  );
  if (userB.userId === userAId) {
    fail('Cross-user RLS negative proof', 'Test account B resolved to the same user as account A');
  }

  const profileRows = await supabaseRows(
    `/rest/v1/user_profiles?select=user_id&user_id=eq.${encodeURIComponent(userAId)}`,
    userB.accessToken,
    'Cross-user profile RLS proof',
  );
  if (profileRows.length !== 0) {
    fail('Cross-user profile RLS proof', 'User B could observe user A profile');
  }
  pass('Cross-user profile RLS proof', 'user B cannot read user A profile');

  const goalRows = await supabaseRows(
    `/rest/v1/goals?select=id,user_id&id=eq.${encodeURIComponent(goalAId)}`,
    userB.accessToken,
    'Cross-user goal RLS proof',
  );
  if (goalRows.length !== 0) {
    fail('Cross-user goal RLS proof', 'User B could observe user A goal');
  }
  pass('Cross-user goal RLS proof', 'user B cannot read user A goal');
}

async function main() {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail('Runtime-proof configuration', `Missing required variables: ${missing.join(', ')}`);
  }
  if (!expectedCommitSha) {
    fail('Runtime-proof configuration', 'APM_COMMIT_SHA or GITHUB_SHA is required to bind proof to exact source');
  }
  if (process.env.APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT !== 'yes') {
    fail(
      'Runtime-proof configuration',
      'Mutation proof requires APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT=yes for dedicated disposable accounts',
    );
  }

  apiBaseUrl = process.env.APM_API_BASE_URL.replace(/\/$/, '');
  supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');

  console.log('A Player Mode runtime proof');
  console.log(`API: ${apiBaseUrl}`);

  currentStage = 'health';
  const health = await apiRequest('/v1/health');
  if (!health.response.ok || health.json?.ok !== true || health.json?.service !== 'aplayer-mode-api') {
    fail('Public health route', `Unexpected health response (${health.response.status})`, { requestId: health.requestId });
  }
  if (!health.requestId) fail('Public health route', 'APM API did not return x-request-id');
  remoteBuildSha = typeof health.json?.buildSha === 'string' ? health.json.buildSha : null;
  if (remoteBuildSha !== expectedCommitSha) {
    fail(
      'Deployed build SHA',
      `Expected ${expectedCommitSha}, received ${remoteBuildSha ?? 'missing'}`,
      { requestId: health.requestId, expectedCommitSha, remoteBuildSha },
    );
  }
  pass('Deployed build SHA', 'remote Worker build matches exact source commit', {
    requestId: health.requestId,
    buildSha: remoteBuildSha,
  });
  pass('Public health route', 'Cloudflare APM API is reachable and request tracing is active', { requestId: health.requestId });

  currentStage = 'anonymous_boundary';
  const unauthenticated = await apiRequest('/v1/me/life-graph');
  if (unauthenticated.response.status !== 401) {
    fail('Private route rejects anonymous requests', `Expected 401, received ${unauthenticated.response.status}`, { requestId: unauthenticated.requestId });
  }
  pass('Private route rejects anonymous requests', 'fail-closed auth boundary works', { requestId: unauthenticated.requestId });

  currentStage = 'authentication';
  const userA = await supabasePasswordSignIn(
    process.env.APM_TEST_EMAIL,
    process.env.APM_TEST_PASSWORD,
    'Primary Supabase test-account sign-in',
  );
  pass('Supabase Auth', 'dedicated runtime-proof account A authenticated');

  currentStage = 'life_graph_read';
  let state = await apiRequest('/v1/me/life-graph', { accessToken: userA.accessToken });
  if (!state.response.ok || state.json?.graph?.identity?.userId !== userA.userId) {
    fail('Authenticated Life Graph read', `User-scoped graph did not match authenticated user (${state.response.status})`, { requestId: state.requestId });
  }
  pass('Authenticated Life Graph read', 'Cloudflare verified Supabase session and returned user-scoped state', { requestId: state.requestId });

  // Always create a fresh proof goal/action. Reusing an arbitrary pre-existing open action made
  // the Radar assertion dependent on old test-account state and could produce a false failure.
  currentStage = 'durable_onboarding';
  const proofLabel = `${expectedCommitSha}-${Date.now()}`;
  const onboarding = await apiRequest('/v1/onboarding', {
    accessToken: userA.accessToken,
    method: 'PUT',
    body: {
      displayName: 'APM Runtime Proof',
      roles: ['runtime-proof-user'],
      primaryGoal: `Runtime proof ${proofLabel}: prove authenticated durable APM execution end to end`,
      currentSeason: 'runtime verification',
      becoming: 'a verified end-to-end system',
      pillar: 'execution',
    },
  });
  if (!onboarding.response.ok || onboarding.json?.graph?.identity?.userId !== userA.userId) {
    fail('Durable onboarding write', `Onboarding mutation failed (${onboarding.response.status})`, { requestId: onboarding.requestId });
  }
  const openAction = onboarding.json?.graph?.nextActions?.find(
    (action) => action.status === 'open' && action.title.includes(proofLabel),
  );
  if (!openAction?.goalId) {
    fail('Durable onboarding write', 'Fresh proof goal did not create the expected open next action', { requestId: onboarding.requestId });
  }
  pass('Durable onboarding write', 'fresh profile/role/goal/next-action state persisted through API/RPC', { requestId: onboarding.requestId });

  currentStage = 'today_projection';
  const today = await apiRequest('/v1/me/today', { accessToken: userA.accessToken });
  if (!today.response.ok || today.json?.plan?.numberOneMove?.id !== openAction.id) {
    fail('Server Today projection', `Today did not select the fresh proof action (${today.response.status})`, { requestId: today.requestId });
  }
  pass('Server Today projection', 'number-one move reconstructed from fresh durable server state', { requestId: today.requestId });

  currentStage = 'completion_evidence';
  const completion = await apiRequest(`/v1/next-actions/${encodeURIComponent(openAction.id)}/complete`, {
    accessToken: userA.accessToken,
    method: 'POST',
  });
  if (
    !completion.response.ok ||
    completion.json?.action?.status !== 'done' ||
    completion.json?.evidence?.relatedActionId !== openAction.id
  ) {
    fail('Completion + evidence transaction', `Completion transaction failed (${completion.response.status})`, { requestId: completion.requestId });
  }
  pass('Completion + evidence transaction', 'action completion and evidence were committed atomically', { requestId: completion.requestId });

  currentStage = 'fresh_reread';
  state = await apiRequest('/v1/me/life-graph', { accessToken: userA.accessToken });
  const durableAction = state.json?.graph?.nextActions?.find((action) => action.id === openAction.id);
  const durableEvidence = state.json?.graph?.evidence?.find((evidence) => evidence.relatedActionId === openAction.id);
  if (!state.response.ok || durableAction?.status !== 'done' || !durableEvidence) {
    fail('Durability after reread', 'Completion/evidence did not survive a fresh server read', { requestId: state.requestId });
  }
  pass('Durability after reread', 'canonical state survives a fresh request', { requestId: state.requestId });

  currentStage = 'radar';
  const proactiveItem = state.json?.graph?.radarItems?.find(
    (item) => item.relatedGoalId === openAction.goalId && item.status === 'open',
  );
  if (!proactiveItem) {
    fail('Deterministic Radar loop', 'Expected a proactive item after completing the fresh proof goal’s only open action');
  }
  pass('Deterministic Radar loop', `Radar surfaced ${proactiveItem.type} without an LLM call`);

  await verifyRlsIsolation(userA.userId, openAction.goalId);

  currentStage = 'complete';
  console.log('\nRUNTIME PROOF RESULT: PASS');
  console.log(`Checks passed: ${proof.filter((item) => item.status === 'PASS').length}`);
  await writeReceipt('PASS');
}

main().catch(async (error) => {
  console.error('\nRUNTIME PROOF RESULT: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  try {
    await writeReceipt('FAIL', error);
  } catch (receiptError) {
    console.error(`Unable to write runtime evidence receipt: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
  }
  process.exit(1);
});
