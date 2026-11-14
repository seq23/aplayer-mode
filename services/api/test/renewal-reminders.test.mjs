// Annual renewal reminder (risk R-SUB-03; Cal. B&P 17602(b); migration 0098). End to end on the
// REAL migration chain in PGlite: real webhook events make the entitlements, the Worker job reads
// who is due through the service RPC, sends through a fake Resend, and records each send.
// Proves: only active auto-renewing annual web/App Store plans 15-45 days out get ONE reminder per
// renewal; a failed send is not recorded (so the next daily run retries); the email carries price,
// date, how to cancel and a link; zero is a named stop; clients cannot reach the functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-16T15:00:00Z'); // the daily 15:00 UTC tick

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

let db; let mod; let outDir;
const admin = async (sql, params) => { await db.exec('reset role'); return db.query(sql, params); };
async function asRole(role, sql, params = []) {
  return db.transaction(async (tx) => { await tx.exec(`set local role ${role}`); return tx.query(sql, params); });
}
let seq = 0;
async function buy(user, email, product, store, expiresAt, extra = []) {
  await admin('insert into auth.users (id, email) values ($1, $2)', [user, email]);
  const events = [{ type: 'INITIAL_PURCHASE' }, ...extra];
  for (const e of events) {
    seq += 1;
    const event = { id: `evt-${seq}`, app_user_id: user, product_id: product, store, environment: 'PRODUCTION', event_timestamp_ms: NOW - DAY * 300 + seq * 1000, expiration_at_ms: expiresAt, ...e };
    await asRole('service_role', 'select public.apm_service_billing_apply_event($1::jsonb, false)', [JSON.stringify(event)]);
  }
}

/** Supabase (routed to PGlite as service_role) + Resend (recorded; `failFor` answers 500). */
function fakeFetch(failFor = new Set()) {
  const emails = [];
  const fetcher = async (url, init) => {
    const href = String(url);
    if (href === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      emails.push({ ...body, key: init.headers['idempotency-key'] });
      return new Response(JSON.stringify(failFor.has(body.to[0]) ? { error: 'down' } : { id: `re_${emails.length}` }), { status: failFor.has(body.to[0]) ? 500 : 200 });
    }
    const fn = href.match(/\/rest\/v1\/rpc\/(\w+)$/)?.[1];
    const args = JSON.parse(init.body);
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
    try {
      const r = (await asRole('service_role', sql, names.map((n) => args[n]))).rows[0].r;
      return new Response(JSON.stringify(r), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: String(error.message) }), { status: /does not exist/.test(error.message) ? 404 : 400 });
    }
  };
  return { emails, fetcher };
}

const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', RESEND_API_KEY: 're_test' };

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-renewal-'));
  await build({ entryPoints: { renewal: fileURLToPath(new URL('../src/renewalReminders.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  mod = await import(pathToFileURL(join(outDir, 'renewal.js')).href);
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) await db.exec(await migration(name));
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('one reminder per annual renewal 15-45 days out, with price, date, how to cancel and a link', async () => {
  // Patch the real global fetch used by serviceRpc (db.ts) to the same fake.
  const fake = fakeFetch(new Set(['fails@example.com']));
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetcher;
  try {
    // Nobody yet: a named stop, never a silent zero.
    const none = await mod.runRenewalReminders(env, new Date(NOW), fake.fetcher);
    assert.equal(none.stop, 'NONE_DUE');
    assert.match(none.output, /^OUTPUT 0 renewal_reminders_sent due=0 failed=0 annual_active=0 NAMED STOP \[NONE_DUE\]$/);

    const in30 = NOW + 30 * DAY;
    await buy(U(1), 'web@example.com', 'apm_web_lifeos_annual', 'RC_BILLING', in30);                       // due (card)
    await buy(U(2), 'apple@example.com', 'apm_cos_annual', 'APP_STORE', in30);                              // due (App Store)
    await buy(U(3), 'play@example.com', 'apm_cos:annual', 'PLAY_STORE', in30);                              // Google sends its own
    await buy(U(4), 'monthly@example.com', 'apm_web_cos_monthly', 'RC_BILLING', in30);                      // not annual
    await buy(U(5), 'early@example.com', 'apm_web_cos_annual', 'RC_BILLING', NOW + 60 * DAY);               // too early
    await buy(U(6), 'late@example.com', 'apm_web_cos_annual', 'RC_BILLING', NOW + 10 * DAY);                // inside 15 days
    await buy(U(7), 'cancelled@example.com', 'apm_web_cos_annual', 'RC_BILLING', in30, [{ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }]); // will not renew
    await buy(U(8), 'fails@example.com', 'apm_web_autopilot_annual', 'RC_BILLING', in30);                   // send fails

    const first = await mod.runRenewalReminders(env, new Date(NOW), fake.fetcher);
    assert.deepEqual([first.sent, first.due, first.failed, first.stop], [2, 3, 1, 'SEND_FAILED']);
    assert.deepEqual(fake.emails.map((e) => e.to[0]).sort(), ['apple@example.com', 'fails@example.com', 'web@example.com']);

    const web = fake.emails.find((e) => e.to[0] === 'web@example.com');
    const date = new Date(in30).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    assert.equal(web.from, 'A Player Mode <billing@mail.aplayermode.com>');
    assert.equal(web.reply_to, 'support@aplayermode.com');
    assert.equal(web.html, undefined, 'plain text only');
    assert.ok(web.subject.includes(date));
    for (const must of ['$399.99', date, 'Settings, then Plan, then Manage subscription', 'No call is needed', 'https://app.aplayermode.com/settings/plan']) assert.ok(web.text.includes(must), `web reminder has ${must}`);
    const apple = fake.emails.find((e) => e.to[0] === 'apple@example.com');
    for (const must of ['$249.99', 'Apple charges it', 'Subscriptions, then A Player Mode']) assert.ok(apple.text.includes(must), `App Store reminder has ${must}`);

    // The next daily run: the two sent are never sent again; the failed one is retried.
    fake.emails.length = 0;
    const again = await mod.runRenewalReminders(env, new Date(NOW + DAY), fake.fetcher);
    assert.deepEqual(fake.emails.map((e) => e.to[0]), ['fails@example.com']);
    assert.equal(again.sent, 0);

    // Only the daily tick runs; without the email key the due count is a named stop.
    assert.equal((await mod.runRenewalReminders(env, new Date(NOW + 15 * 60_000), fake.fetcher)).stop, 'NOT_THIS_TICK');
    assert.equal((await mod.runRenewalReminders({ ...env, RESEND_API_KEY: undefined }, new Date(NOW + DAY), fake.fetcher)).stop, 'EMAIL_NOT_CONFIGURED');
  } finally { globalThis.fetch = realFetch; }

  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, 'select public.apm_service_billing_renewal_reminders_due(now())'), /permission denied/);
    await assert.rejects(asRole(role, 'select * from private.billing_renewal_reminders'), /permission denied/);
  }
});
