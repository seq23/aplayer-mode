# APM API — Cloudflare service boundary

This directory is reserved for the server-side A Player Mode API deployed to Cloudflare Workers.

## Responsibilities

- authenticate mobile/web requests;
- enforce user/tenant boundaries;
- read/write durable Life Graph state;
- run Privacy Gateway and Model Registry checks;
- call OpenRouter using the server-only `OPENROUTER_API_KEY` secret;
- enforce permission/policy checks before future connector actions;
- emit audit/evaluation metadata without logging private prompt bodies by default.

## Secrets

Production secrets are configured in Cloudflare Workers Secrets / Secrets Store. They are **not committed to this repository**.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it locally. `.dev.vars` is gitignored.

## Deployment split

The API deploys to Cloudflare. The React Native application is built with Expo EAS and distributed through Apple/Google app stores. The mobile app calls this API; it does not call OpenRouter using APM's production key.

Implementation of the Worker runtime begins in the durable-backend phase described in `docs/13-IMPLEMENTATION-STATUS.md`.
