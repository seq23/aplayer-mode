// The monthly AI cost backstop's sum (0107 apm_ai_cost_microusd_since) on the REAL migration chain:
// only the service role may call it; a signed-in client that inserts its own usage rows can never
// LOWER its month (a negative cost counts as zero) nor touch another person's; earlier months and
// other users are not counted (review of #98: the abuse case).
import test from 'node:test';
import assert from 'node:assert/strict';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

let h;
const A = U(1); const B = U(2);
test.before(async () => {
  h = await realChain();
  await h.admin(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test')`, [A, B]);
});
const sum = async (user, since) => Number((await h.service(`select public.apm_ai_cost_microusd_since($1, $2) as v`, [user, since])).rows[0].v);
const MONTH = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

test('a lying client cannot lower its own month or reach anyone else; only the service role reads the sum', async () => {
  await h.service(`insert into public.ai_usage_events (user_id, task_type, data_class, success, cost_microusd) values ($1, 'coaching', 'private_life', true, 4000000)`, [A]);
  assert.equal(await sum(A, MONTH), 4_000_000);
  // The client writes its own rows (allowed by RLS): a negative cost to undo its spend.
  await h.as(A, `insert into public.ai_usage_events (user_id, task_type, data_class, success, cost_microusd) values ($1, 'coaching', 'private_life', true, -10000000)`, [A]);
  assert.equal(await sum(A, MONTH), 4_000_000, 'a negative cost never lowers the month');
  // A row for someone else is refused by RLS.
  await rejects(h.as(A, `insert into public.ai_usage_events (user_id, task_type, data_class, success, cost_microusd) values ($1, 'coaching', 'private_life', true, -5)`, [B]), /row-level security|violates/);
  assert.equal(await sum(B, MONTH), 0);
  // Last month's spend is not this month's.
  await h.service(`insert into public.ai_usage_events (user_id, task_type, data_class, success, cost_microusd, created_at) values ($1, 'coaching', 'private_life', true, 9000000, $2::timestamptz - interval '1 day')`, [B, MONTH]);
  assert.equal(await sum(B, MONTH), 0);
  // Neither a client nor anon may call the sum.
  await rejects(h.as(A, `select public.apm_ai_cost_microusd_since($1, $2)`, [A, MONTH]), /permission denied/);
  await rejects(h.asRole('anon', null, `select public.apm_ai_cost_microusd_since($1, $2)`, [A, MONTH]), /permission denied/);
});

test('0107 approves DeepSeek for coaching only, thinking off, and leaves the existing Mistral route as it was', async () => {
  const rows = (await h.admin(`select route_id, status, capabilities, data_classes_allowed, training_allowed, retention, reasoning_disabled from public.model_routes where route_id in ('or_deepseek_v4_1_flash_deepinfra', 'or_mistral_small_3_2_24b_deepinfra') order by route_id`)).rows;
  const [deepseek, mistral] = rows;
  assert.deepEqual({ ...deepseek }, { route_id: 'or_deepseek_v4_1_flash_deepinfra', status: 'approved', capabilities: ['conversation', 'reasoning', 'structured_output'], data_classes_allowed: ['public_synthetic', 'low_personal', 'private_life'], training_allowed: false, retention: 'zero', reasoning_disabled: true });
  assert.equal(mistral.status, 'approved');
  assert.equal(mistral.reasoning_disabled, false);
});
