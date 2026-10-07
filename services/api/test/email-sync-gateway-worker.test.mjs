// End to end through the Worker's email sync and AI gateway (api P1-3, P2-8, P2-9, P2-10;
// engine P1-3, P1-4, P2-3): a malformed model answer or a highly sensitive message skips
// that message instead of aborting the sync; secrets in the body are redacted before the
// model sees them; commitments upsert on the full source identity; the usage row carries
// the reported cost and the effective class, and a failed usage write never loses a result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let email; let gateway; let crypto;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-email-sync-'));
  await build({ entryPoints: { email: join(srcDir, 'connectors/email.ts'), gateway: join(srcDir, 'aiGateway.ts'), crypto: join(srcDir, 'crypto.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  const load = (name) => import(pathToFileURL(join(outDir, `${name}.js`)).href);
  [email, gateway, crypto] = await Promise.all([load('email'), load('gateway'), load('crypto')]);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const CONN = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OPENROUTER_API_KEY: 'sk-or-test-key', CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString('base64') };
const routeRow = { route_id: 'zdr', model_id: 'vendor/model', provider_id: 'Vendor', status: 'approved', cost_class: 'standard', capabilities: ['extraction', 'structured_output'],
  data_classes_allowed: ['private_life', 'highly_sensitive'], training_allowed: false, retention: 'zero', approved_for_highly_sensitive: false, quality_score: 90, reliability_score: 90, latency_score: 90,
  last_policy_reviewed_at: '2026-10-06T00:00:00Z', last_eval_run_at: null };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_');

test('email sync: bad answers and sensitive messages are skipped, secrets redacted, commitments keyed on title, cost recorded', async () => {
  const encrypted = await crypto.encryptConnectorCredential(env, { accessToken: 'ya29.token', expiresAt: Date.now() + 3_600_000 });
  const bodies = {
    m1: 'Please send the deck by Friday. My password is hunter2.',
    m2: 'Café meeting moved — confirm by Monday',
    m3: 'Your lab results are ready in the patient portal',
  };
  const answers = [JSON.stringify({ signals: [{ type: 'deadline', summary: 'Send the deck', owner: 'user', dueAt: 'Friday', confidence: 0.9 }] }), '{}'];
  const calls = { openrouter: [], usage: [], commitments: [], synced: false };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); const method = init.method ?? 'GET';
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (href.includes('/rest/v1/integration_connections') && method === 'GET') return json([{ id: CONN, provider: 'google', kind: 'email', encrypted_credentials: encrypted.ciphertext, credential_iv: encrypted.iv }]);
    if (href.includes('/rest/v1/integration_connections') && method === 'PATCH') { calls.synced = true; return new Response(null, { status: 204 }); }
    if (href.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
    const id = href.match(/messages\/(m\d)\?/)?.[1];
    if (id) return json({ id, payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: id }], body: { data: b64(bodies[id]) } } });
    if (href.includes('/rest/v1/model_routes')) return json([routeRow]);
    if (href.startsWith('https://openrouter.ai/')) {
      const body = JSON.parse(init.body); calls.openrouter.push(body.messages[1].content);
      return json({ choices: [{ message: { content: answers.shift() } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 } });
    }
    if (href.includes('/rest/v1/ai_usage_events')) { calls.usage.push(JSON.parse(init.body)[0]); return new Response(null, { status: 201 }); }
    if (href.includes('/rest/v1/message_signals') && method === 'POST') return json([{ id: 'sig1' }]);
    if (href.includes('/rest/v1/message_signals') && method === 'PATCH') return new Response(null, { status: 204 });
    if (href.includes('/rest/v1/commitments')) { calls.commitments.push({ href, prefer: new Headers(init.headers).get('prefer'), body: JSON.parse(init.body) }); return json([{ id: 'c1' }]); }
    throw new Error(`unexpected ${method} ${href}`);
  };
  try {
    const result = await email.syncEmailSignals({ env, accessToken: 'jwt', userId: USER, connectionId: CONN });
    assert.deepEqual(result, { provider: 'google', messagesProcessed: 3, signalsStored: 1 });
    assert.ok(calls.synced, 'last_sync_at is written: the sync completed');
    assert.equal(calls.openrouter.length, 2, 'the lab-results message never reached an unvetted route');
    assert.doesNotMatch(calls.openrouter[0], /hunter2/);
    assert.match(calls.openrouter[1], /Café meeting moved — confirm/, 'UTF-8 intact');
    assert.match(calls.commitments[0].href, /on_conflict=user_id,source_type,source_ref,title/);
    assert.match(calls.commitments[0].prefer, /ignore-duplicates/);
    assert.equal(calls.commitments[0].body[0].due_at, null, 'an unparseable dueAt is null, never a failed cast');
    const ok = calls.usage.find((row) => row.success);
    assert.deepEqual([ok.cost_microusd, ok.data_class], [200, 'private_life']);
    const refused = calls.usage.filter((row) => !row.success).map((row) => [row.error_code, row.data_class]);
    assert.deepEqual(refused.sort(), [['InferenceResponseError', 'private_life'], ['NoEligibleModelRouteError', 'highly_sensitive']].sort());
  } finally { globalThis.fetch = original; }
});

test('a failed usage write never throws away a successful inference', async () => {
  const original = globalThis.fetch;
  let usageWrites = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/rest/v1/model_routes')) return new Response(JSON.stringify([routeRow]), { status: 200 });
    if (href.startsWith('https://openrouter.ai/')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.001 } }), { status: 200 });
    if (href.includes('/rest/v1/ai_usage_events')) { usageWrites += 1; return new Response('{}', { status: 500 }); }
    throw new Error(`unexpected ${href}`);
  };
  const errors = []; const originalError = console.error; console.error = (...args) => errors.push(args);
  try {
    const value = await gateway.runUserInference({ env, accessToken: 'jwt', userId: USER, task: { taskType: 't', dataClass: 'private_life', requiredCapabilities: ['extraction'], system: 's', instruction: 'i', context: {}, jsonSchema: { name: 'x', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } });
    assert.deepEqual(value, { ok: true });
    assert.equal(usageWrites, 1, 'counted once, never a second failure row');
    assert.ok(errors.some((args) => String(args[0]).includes('usage write failed')));
    assert.equal(gateway.costMicroUsd(0.001), 1000);
    assert.equal(gateway.costMicroUsd(undefined), 0);
  } finally { globalThis.fetch = original; console.error = originalError; }
});

test('the classifier never fires on APM’s own coaching rule text (no false class-3 lock-out of coaching)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apm-cls-'));
  try {
    await build({ entryPoints: { p: fileURLToPath(new URL('../../../packages/privacy/src/index.ts', import.meta.url)), t: join(srcDir, 'coach/tracks.ts'), m: join(srcDir, 'coach/modes.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: dir, logLevel: 'silent' });
    const [p, t, m] = await Promise.all(['p', 't', 'm'].map((name) => import(pathToFileURL(join(dir, `${name}.js`)).href)));
    assert.deepEqual(p.classifySensitivity([JSON.stringify(t.TRACK_LIBRARY), JSON.stringify(m.MODE_LIBRARY)]), { highlySensitive: false, kinds: [] });
    assert.equal(p.classifySensitivity(['I was diagnosed with type 2 diabetes and take 500 mg of metformin']).highlySensitive, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
