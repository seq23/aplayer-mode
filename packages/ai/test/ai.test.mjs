// @apm/ai: route selection never picks a candidate or an ineligible route, the provider
// policy shape is pinned, and runOpenRouterInference redacts secrets, raises the data
// class from content, validates structured output against its schema and reports cost
// (engine P1-3, P1-4, P2-2, P2-3; api P2-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let ai; let outDir;
test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-ai-'));
  await build({ entryPoints: { ai: fileURLToPath(new URL('../src/index.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  ai = await import(pathToFileURL(join(outDir, 'ai.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const route = (over = {}) => ({
  routeId: 'zdr-1', modelId: 'vendor/model-a', providerId: 'vendor', status: 'approved', costClass: 'standard',
  capabilities: ['extraction', 'structured_output', 'conversation', 'reasoning'], dataClassesAllowed: ['private_life', 'highly_sensitive', 'public_synthetic', 'low_personal'],
  trainingAllowed: false, retention: 'zero', approvedForHighlySensitive: false, qualityScore: 80, reliabilityScore: 80, latencyScore: 80,
  lastPolicyReviewedAt: '2026-10-01', ...over,
});
const request = { dataClass: 'private_life', requiredCapabilities: ['extraction'] };

test('route selection: candidates, disabled, training, non-ZDR and generic routers are never chosen for private data', () => {
  assert.equal(ai.selectModelRoute([route({ status: 'candidate' })], request), null);
  assert.equal(ai.selectModelRoute([route({ status: 'disabled' })], request), null);
  assert.equal(ai.selectModelRoute([route({ trainingAllowed: true })], request), null);
  assert.equal(ai.selectModelRoute([route({ retention: 'limited' })], request), null);
  assert.equal(ai.selectModelRoute([route({ dataClassesAllowed: ['low_personal'] })], request), null);
  assert.equal(ai.selectModelRoute([route({ capabilities: ['conversation'] })], request), null);
  assert.equal(ai.selectModelRoute([route({ qualityScore: 60 })], { ...request, minimumQualityScore: 70 }), null);
  assert.equal(ai.selectModelRoute([route({ modelId: 'openrouter/auto' })], request), null, 'a generic router only takes synthetic data');
  assert.ok(ai.selectModelRoute([route({ modelId: 'openrouter/auto' })], { ...request, dataClass: 'public_synthetic' }));
  assert.equal(ai.selectModelRoute([route()], { ...request, dataClass: 'highly_sensitive' }), null);
  assert.ok(ai.selectModelRoute([route({ approvedForHighlySensitive: true })], { ...request, dataClass: 'highly_sensitive' }));
  // Locked order: reliability → quality → cost → latency.
  const picked = ai.selectModelRoute([route({ routeId: 'cheap', costClass: 'low' }), route({ routeId: 'reliable', reliabilityScore: 95 })], request);
  assert.equal(picked.route.routeId, 'reliable');
});

test('the provider policy pins no fallbacks, no data collection and ZDR', () => {
  assert.deepEqual(ai.buildOpenRouterProviderPolicy(route()), { allow_fallbacks: false, data_collection: 'deny', zdr: true, only: ['vendor'], require_parameters: true });
  assert.throws(() => ai.buildOpenRouterProviderPolicy(route({ status: 'candidate' })), /not approved/);
});

function mockOpenRouter(content, usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.00042 }) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: 'vendor/model-a', choices: [{ message: { content } }], usage }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const schema = { name: 's', schema: { type: 'object', properties: { signals: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['deadline'] }, confidence: { type: 'number' }, dueAt: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['type', 'confidence', 'dueAt'], additionalProperties: false } } }, required: ['signals'], additionalProperties: false } };
const task = (over = {}) => ({ taskType: 'email_signal_extraction', dataClass: 'private_life', requiredCapabilities: ['extraction', 'structured_output'], system: 'Extract facts.', instruction: 'Return JSON.', context: { sourceText: 'Lunch Friday' }, jsonSchema: schema, ...over });

test('inference redacts credentials, refuses secret fields, and reports cost and the effective class', async () => {
  const mock = mockOpenRouter(JSON.stringify({ signals: [{ type: 'deadline', confidence: 0.9, dueAt: null }] }));
  try {
    const result = await ai.runOpenRouterInference({ apiKey: 'k', routes: [route()], task: task({ context: { sourceText: 'Your API key is sk-or-v1-abc123 and password hunter2' } }) });
    const sent = mock.calls[0].body.messages[1].content;
    assert.doesNotMatch(sent, /sk-or-v1-abc123|hunter2/);
    assert.equal(result.redactions, 2);
    assert.equal(result.usage.costUsd, 0.00042);
    assert.deepEqual(mock.calls[0].body.usage, { include: true });
    assert.equal(result.dataClass, 'private_life');
    await assert.rejects(ai.runOpenRouterInference({ apiKey: 'k', routes: [route()], task: task({ context: { authorization: 'x' } }) }), /Secret-like field/);
    assert.equal(mock.calls.length, 1, 'refused before any request');
  } finally { mock.restore(); }
});

test('health or financial content is highly sensitive: an unvetted route never receives it', async () => {
  const mock = mockOpenRouter(JSON.stringify({ signals: [] }));
  try {
    const sensitive = task({ context: { sourceText: 'Your lab results are ready in the patient portal' } });
    await assert.rejects(ai.runOpenRouterInference({ apiKey: 'k', routes: [route()], task: sensitive }), (error) => error instanceof ai.NoEligibleModelRouteError && error.dataClass === 'highly_sensitive');
    assert.equal(mock.calls.length, 0);
    const vetted = await ai.runOpenRouterInference({ apiKey: 'k', routes: [route({ approvedForHighlySensitive: true })], task: sensitive });
    assert.equal(vetted.dataClass, 'highly_sensitive');
  } finally { mock.restore(); }
});

test('structured output must match its schema; valid JSON in the wrong shape is refused', async () => {
  for (const bad of ['{}', JSON.stringify({ signals: [{ type: 'other', confidence: 1, dueAt: null }] }), JSON.stringify({ signals: [{ type: 'deadline', confidence: '1', dueAt: null }] }), JSON.stringify({ signals: [], extra: 1 }), 'not json']) {
    const mock = mockOpenRouter(bad);
    try {
      await assert.rejects(ai.runOpenRouterInference({ apiKey: 'k', routes: [route()], task: task() }), (error) => error instanceof ai.InferenceResponseError && /schema_mismatch|invalid JSON/.test(error.message), bad);
    } finally { mock.restore(); }
  }
  assert.deepEqual(ai.validateJsonSchema({ a: 1 }, { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false }), []);
  assert.deepEqual(ai.validateJsonSchema({ a: 1.5 }, { type: 'object', properties: { a: { type: 'integer' } } }), ['$.a: expected integer']);
});
