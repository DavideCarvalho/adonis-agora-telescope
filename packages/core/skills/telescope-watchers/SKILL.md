---
name: telescope-watchers
description: >-
  Capture sources with @adonis-agora/telescope — built-in request/diagnostics/logs
  watchers, the @adonis-agora/telescope/watchers subpath (LucidQueryWatcher db:query,
  MailWatcher mail:sent, CacheWatcher cache:* events, HttpClientWatcher fetch wrap,
  QueueWatcher boringqueue.job.execute, EventsWatcher onAny, RedisWatcher
  sendCommand, profile()/startProfile(), scheduleTask()/registerSchedule()), and
  custom watchers via the Watcher contract + safeRecord + currentTraceId. Use for
  "record SQL queries", "watch outbound HTTP", "no queries recorded", "write a
  custom watcher", "correlate entries to a trace", "AdonisJS telemetry".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "0.8.4"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/concepts/capture.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/watchers.mdx"
  - "DavideCarvalho/adonis-telescope:docs/recipes/custom-watcher.mdx"
  - "DavideCarvalho/adonis-telescope:packages/core/src/watchers/index.ts"
---

# Watchers & capture

The core records requests, exceptions and diagnostics automatically. Every other
source — Lucid SQL, outbound fetch, mail, cache, queue jobs, events, Redis, logs,
timing spans, scheduled tasks — comes from a watcher. Per-technology watchers live
in the `@adonis-agora/telescope/watchers` subpath of the same package; nothing extra
to install.

## Setup

Re-run configure and pick **Watchers**, then tune the published config:

```sh
node ace configure @adonis-agora/telescope   # pick "Watchers" at the prompt
```

```ts
// config/telescope_watchers.ts
import { defineConfig } from '@adonis-agora/telescope/watchers'

export default defineConfig({
  enabled: true,
  watchers: ['query'],   // only the verified Lucid query watcher is on by default
  query: { slowMs: 500, captureBindings: false, normalize: true },
  httpClient: { slowMs: 1000, ignoreHosts: [], captureBodies: false }, // body SIZES, never bytes
})
```

Enable more watchers by adding names: `'query'`, `'mail'`, `'cache'`,
`'http-client'`, `'logs'`, `'queue'`, `'events'`, `'redis'`, `'profiling'`,
`'schedule'`, `'queue-manager'`.

Source: `docs/packages/watchers.mdx` (Configuration).

## Core patterns

### Pattern 1 — record every Lucid query

The query watcher subscribes to Lucid's `db:query` event. Entries group by a
normalized SQL template hash (`select * from users where id = ?`), so every
execution of the same statement rolls into one family for `topFamilies()`.

```ts
// config/telescope_watchers.ts
export default defineConfig({
  watchers: ['query'],
  // Bindings carry PII/secrets: redacted to [REDACTED] placeholders unless you opt in.
  query: { slowMs: 500, captureBindings: false, normalize: true },
  // ignoreConnections: ['telescope'] — drop e.g. telescope's own lucid-store writes.
})
```

Lucid only **emits** `db:query` when the connection's `debug` flag is on or a
listener exists at report time; subscribing the watcher is enough to make Lucid
report, but `debug: true` in your DB config guarantees it:

```ts
// config/database.ts
export const databaseConfig = defineConfig({
  connections: {
    pg: {
      connection: { host: '127.0.0.1', database: 'app', user: 'postgres', password: 'secret' },
      debug: true,   // guarantee db:query flows even before any other listener attaches
    },
  },
})
```

Source: `docs/packages/watchers.mdx` (Query watcher callouts),
`docs/getting-started.mdx` Step 5.

### Pattern 2 — user-instrumented spans and scheduled runs

`profile()`/`startProfile()` and `scheduleTask()`/`registerSchedule()` are helpers
you call around code — nothing is captured until the watcher is enabled AND a
helper runs. While disabled they are zero-cost no-ops that still execute your
closure.

```ts
import {
  profile,
  scheduleTask,
  registerSchedule,
} from '@adonis-agora/telescope/watchers'

// Timing span — times fn, records completed/failed, re-throws on error.
const total = await profile('checkout', async (span) => {
  span.mark('cart-loaded')
  return await charge(cart)
})

// Scheduled run — wraps the closure you actually schedule.
await scheduleTask('prune-sessions', () => sessions.pruneExpired(), {
  schedule: '0 * * * *',
  kind: 'cron',
})

// Register what EXISTS so the dashboard can compute next-run
// (optional cron-parser peer; without it nextRunAt is null, not an error).
registerSchedule({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' })
```

Source: `docs/packages/watchers.mdx` (Profiling watcher, Schedule watcher).

### Pattern 3 — a custom watcher

Implement `{ type, start(emitter), stop() }` over the structural `EmitterLike`
(`on` returns an unsubscribe function). Record through `safeRecord(input, source)`:
it resolves the runtime store, backfills `currentTraceId()`, and swallows every
failure so your watcher cannot break the path it observes.

```ts
// app/telescope/queue_watcher.ts
import { EntryType, type RecordInput, currentTraceId } from '@adonis-agora/telescope'
import { safeRecord, type Watcher, type EmitterLike } from '@adonis-agora/telescope/watchers'

export class QueueWatcher implements Watcher {
  readonly type = EntryType.Job
  private unsubscribe: (() => void) | null = null

  start(emitter: EmitterLike): void {
    if (this.unsubscribe) return                       // idempotent
    this.unsubscribe = emitter.on('queue:processed', (data) => this.handle(data))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private handle(data: unknown): void {
    if (!isQueueEvent(data)) return                    // tolerate junk on the channel
    safeRecord(buildJobEntry(data), 'QueueWatcher')    // guarded; never throws
  }
}

function isQueueEvent(d: unknown): d is { queue: string; jobId: string; durationMs: number; failed: boolean } {
  return typeof d === 'object' && d !== null && 'queue' in d && 'jobId' in d
}

function buildJobEntry(e: { queue: string; jobId: string; durationMs: number; failed: boolean }): RecordInput {
  const traceId = currentTraceId()
  return {
    type: EntryType.Job,
    familyHash: e.queue,                               // topFamilies(10, 'job') rolls up here
    durationMs: e.durationMs,
    traceId,
    tags: [`queue:${e.queue}`, ...(e.failed ? ['failed'] : [])],
    content: { queue: e.queue, jobId: e.jobId, failed: e.failed, durationMs: e.durationMs },
  }
}
```

Start it yourself in a provider (`boot()` → resolve `'emitter'` from the container
→ `watcher.start(emitter)`; `shutdown()` → `stop()`). The watchers config controls
only the built-ins — a custom watcher is just a class you start.

Source: `docs/recipes/custom-watcher.mdx`.

### Pattern 4 — tag entries by tenant/user

`getContextAccessor()` reads `@adonis-agora/context` structurally; add tags at
record time so `list({ tag })` pivots on them.

```ts
import { getContextAccessor, type RecordInput } from '@adonis-agora/telescope'

export function withTenantTag<T>(input: RecordInput<T>): RecordInput<T> {
  const tenant = getContextAccessor()?.tenantId()
  if (tenant === undefined) return input
  return { ...input, tags: [...(input.tags ?? []), `tenant:${tenant}`] }
}
```

Source: `docs/recipes/tags-and-redaction.mdx`, `docs/recipes/request-context.mdx`.

## Common mistakes

### CRITICAL Enabling the query watcher without Lucid debug

```ts
// Wrong — the watcher is listed, yet zero queries appear.
export default defineConfig({ watchers: ['query'] })
// config/database.ts has no debug flag and no other db:query listener exists.
```

```ts
// Correct — turn on debug for the connection (or attach another db:query listener).
pg: { /* ... */ debug: true }
```

Mechanism: Lucid builds the `db:query` event only when `debug` is on or a listener
exists at report time — otherwise the event is never even constructed, so the
enabled watcher silently records nothing while looking healthy.
Source: `docs/packages/watchers.mdx` (Query watcher warn callout),
`docs/getting-started.mdx` Step 5.

### HIGH Enabling the logs watcher in both config files

```ts
// Wrong — 'logs' in config/telescope.ts AND config/telescope_watchers.ts.
// config/telescope.ts
export default defineConfig({ watchers: ['request', 'diagnostics', 'logs'], logs: { minLevel: 'warn' } })
// config/telescope_watchers.ts
export default defineConfig({ watchers: ['query', 'logs'] })
```

```ts
// Correct — enable it in exactly one place.
export default defineConfig({ watchers: ['request', 'diagnostics', 'logs'], logs: { minLevel: 'warn' } })
export default defineConfig({ watchers: ['query'] })
```

Mechanism: whichever provider boots first owns the logger tap; the other warns and
stays inert, so its `minLevel`/`tags` options are silently ignored.
Source: `docs/reference/configuration.mdx` ('logs' warn callout).

### HIGH Building entry content outside safeRecord

```ts
// Wrong — content building runs on the HOST thread; one circular payload breaks
// the very operation being observed.
emitter.on('queue:processed', (d) => {
  safeRecord({ type: EntryType.Job, content: JSON.parse(JSON.stringify(d.raw)) }, 'QueueWatcher')
})
```

```ts
// Correct — validate defensively, build plain content, let safeRecord guard the store.
private handle(data: unknown): void {
  if (!isQueueEvent(data)) return
  safeRecord(buildJobEntry(data), 'QueueWatcher')
}
```

Mechanism: recording paths are fire-and-forget and fully guarded — a missing store,
a throwing `record`, or a rejected promise is swallowed and warn-logged, never
thrown into the request/job/query being watched.
Source: `docs/concepts/capture.mdx` (warn callout), `docs/recipes/custom-watcher.mdx`.

### MEDIUM Non-idempotent start/leaky stop in a custom watcher

```ts
// Wrong — double-subscribe duplicates every entry; a leaked subscription keeps
// recording after shutdown.
start(emitter: EmitterLike): void {
  emitter.on('queue:processed', this.handle)
}
stop(): void {}
```

```ts
// Correct — keep the unsubscribe fn; guard re-entry; release in stop().
start(emitter: EmitterLike): void {
  if (this.unsubscribe) return
  this.unsubscribe = emitter.on('queue:processed', this.handle)
}
stop(): void {
  this.unsubscribe?.()
  this.unsubscribe = null
}
```

Mechanism: `emitter.on` returns an unsubscribe function; a watcher that leaks it
records entries into a torn-down process and double-starts duplicate everything.
Source: `docs/recipes/custom-watcher.mdx` (warn callout).

### MEDIUM Waiting on queue/redis watchers whose engines were never installed

```ts
// Wrong — assuming pnpm installed the engines because the watcher names are valid.
export default defineConfig({ watchers: ['queue', 'redis'] })
// package.json has no @adonisjs/queue / @adonisjs/redis entry.
```

```json
// Correct — add the packages yourself; they are NOT declared peers.
{
  "dependencies": {
    "@adonisjs/queue": "^...",
    "@adonisjs/redis": "^..."
  }
}
```

Mechanism: those two are deliberately not declared peers — their watchers tap a
Node diagnostics channel / wrap a manager they're handed, idle when nobody feeds
them, and npm will never install them for you.
Source: `docs/packages/watchers.mdx` (Peer dependencies).

See also: `telescope-storage-retention/SKILL.md` — where captured entries land and
how bounds/sampling shape what survives;
`telescope-alerts-ai/SKILL.md` — rules only ever see what was recorded.
