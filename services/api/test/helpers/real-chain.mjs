// Shared harness: the REAL migration chain applied in order to PGlite with a
// Supabase-shaped substrate (roles, auth.users, auth.uid()).
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

export const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

export async function realChain() {
  const db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec((await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''));
  }
  const admin = async (sql, params) => { await db.exec('reset role'); return db.query(sql, params); };
  const asRole = (role, userId, sql, params = []) => db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', true);`);
    return tx.query(sql, params);
  });
  const as = (userId, sql, params) => asRole('authenticated', userId, sql, params);
  const service = (sql, params) => asRole('service_role', null, sql, params);
  return { db, admin, asRole, as, service };
}

export async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
}
