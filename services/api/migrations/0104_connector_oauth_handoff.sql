-- 0104: account-linking phishing (review 2-3 finding 5, 21 Nov 2026). Additive only.
--
-- The provider callback no longer links an account. It parks the encrypted authorization code
-- and the hash of a one-time handoff that only the client which finished consent receives.
-- POST /v1/connections/oauth/complete then links it, and only for the signed-in user who
-- started the flow. `client` says where the callback returns: the app's auth sheet or the web
-- app's /oauth/complete page.
alter table public.connector_oauth_flows
  add column code_ciphertext text,
  add column code_iv text,
  add column handoff_hash text,
  add column client text not null default 'app' check (client in ('app', 'web'));

-- A data export never shows the parked code or the handoff.
update private.data_rights_tables
  set redact_columns = '{id,verifier_ciphertext,verifier_iv,code_ciphertext,code_iv,handoff_hash}'
  where table_schema = 'public' and table_name = 'connector_oauth_flows';
