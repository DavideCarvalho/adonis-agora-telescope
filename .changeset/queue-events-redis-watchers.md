---
'@adonis-agora/telescope': minor
---

Add three per-technology watchers, ports of the NestJS originals:

- **queue** — records `@adonisjs/queue` job executions (queue, job name, payload, status, attempts, duration) by subscribing to the engine's (`@boringnode/queue`) `node:diagnostics_channel` execution trace. Optional peer: a pure no-op when nothing publishes (peer absent).
- **events** — records every event emitted through the core `@adonisjs/core` Emitter via `emitter.onAny(...)` (name + payload), with a configurable ignore-list (`db:query` / `mail:sent` excluded by default to avoid double-recording the query/mail watchers).
- **redis** — records `@adonisjs/redis` commands (command, args, connection, duration) by wrapping the underlying ioredis `sendCommand` on each connection (current and future, via the manager's `connection` event). Optional peer: a no-op when the manager is absent.

All three are registered in `config/telescope_watchers.ts` with a toggle, route entries through the central redacting store, and degrade gracefully when their optional peer is missing.

The **schedule** watcher was intentionally **skipped**: AdonisJS has no first-party scheduler (unlike `@nestjs/schedule`), and community schedulers expose no event/hook surface to tap without inventing an API. In the Agora ecosystem `@adonis-agora/durable` already bridges scheduled/cron runs onto the diagnostics bus, which the existing diagnostics watcher records — so scheduled-run observability is covered there.
