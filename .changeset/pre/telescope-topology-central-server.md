---
"@adonis-agora/telescope": minor
---

Central server inside telescope: `topology: 'standalone' | 'control-plane' | 'tenant'` in `config/telescope.ts`, like durable and flags.

- `topology: 'control-plane'` with a top-level `verifyTenant` (a function, a class instance or `() => import()`; `authkitTenantVerifier({ issuer, resource: 'urn:agora:telescope' })` or `sharedSecretVerifier({ partitions })`) mounts `POST /_telescope/v1/ingest` and `GET /_telescope/v1/whoami`. Entries are tagged `app:`/`env:` from the token, stored as `<app>:<id>` (a batch sent twice is stored once), with size limits under `ingest`.
- `topology: 'tenant'` with `tenant: { url, partition, token, local?, buffer? }` sends entries in batches from a bounded buffer, with retries and backoff, a fresh token after a 401/403, smaller batches after a 413, the original id and `createdAt`, and a flush at shutdown. `local` keeps a copy in a local store for the app's own console.
- `standalone` stays the default: an app that sets no `topology` behaves as before.
- New: `node ace telescope:server:status`; doctor checks `telescope.topology`, `telescope.topology-store`, `telescope.ingest-csrf`, `telescope.server-reachable`; `telescopeCsrfExceptions` for Shield. Docs: Concepts → Central Server.

Replaces `@adonis-agora/telescope-server`: move `config/telescope_server.ts` into `config/telescope.ts` and drop `remoteStore()` (use `tenant.local` for the local copy).
