---
'@adonis-agora/telescope': minor
---

Central server: choose how a tenant's entries reach the control plane. Set `transport` on both sides with `transports.http({ url, fetch?, timeoutMs? })` (the default, and what `tenant.url` means), `transports.queue(...)` (`@adonisjs/queue`), `transports.bullmq(...)`, `transports.redis(...)` (a Redis stream) or `transports.durable(...)` (a step over a transport from `config/durable.ts`). A driver loads its package only when you choose it.

Every message carries the app's token, and the control plane checks it with `verifyTenant` on each one. App and environment tags come from the token. A message delivered twice is stored once, the ingest size limits apply, and bad messages are dead-lettered instead of retried forever. The tenant keeps its local buffer, retries, flush on shutdown and recording times on every driver.

Only app → server traffic changes: the console, live tail and client errors stay on HTTP. A control plane on a broker keeps its HTTP ingest route, so a fleet can mix HTTP and broker tenants. With `transport` set, `tenant.url` is no longer needed. New doctor check `telescope.transport` (with `--deep`) says whether the broker answers. Standalone apps and HTTP tenants work as before.
