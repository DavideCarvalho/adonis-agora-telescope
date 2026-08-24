---
name: telescope-storage-retention
description: >-
  Storage, retention, redaction and sampling in @adonis-agora/telescope — the
  storage.memory ring buffer vs the storage.lucid SQL driver (optional peer,
  create_telescope_entries_table migration), the TelescopeStore contract
  (record/get/list/count/prune/clear), prune {after,keepLast,intervalMs}, the
  overload guard + setTelescopePaused, redact {keys,perType}, tail-sampling rules
  {rate,keepErrors,keepSlowMs}, and writing a custom store that resolves
  traceId/origin. Use for "persistent storage", "entries lost on restart",
  "table keeps growing", "redact secrets", "sample noisy entry types", "custom
  store".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "0.8.4"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/concepts/storage.mdx"
  - "DavideCarvalho/adonis-telescope:docs/concepts/protection.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/storages.mdx"
  - "DavideCarvalho/adonis-telescope:docs/recipes/custom-storage.mdx"
---

# Storage, retention & protection

A store sits between capture and query: watchers `record` into it, and
`TelescopeService` reads out of it. Storage is **config-driven** — build named
drivers with the `storage` factory, pick one with `store`. Two ship in the box:
`memory` (bounded ring buffer) and `lucid` (persistent SQL via an optional
`@adonisjs/lucid` peer imported lazily only when selected).

## Setup

```ts
// config/telescope.ts
import { defineConfig, storage } from '@adonis-agora/telescope'

export default defineConfig({
  store: 'lucid',
  stores: {
    memory: storage.memory({ limit: 5000 }),   // dev/tests — per-process, lost on restart
    lucid: storage.lucid(),                    // or storage.lucid({ connection: 'pg', tableName: 'tscope' })
  },
  // Retention pruner — OFF unless a prune block is present.
  prune: { after: '24h', keepLast: 50_000, intervalMs: 60_000 },
  // Event-loop overload guard (on by default): pauses ingestion when p99 lag >= maxEventLoopLagMs.
  overload: { enabled: true, maxEventLoopLagMs: 200, startupGraceMs: 5_000 },
})
```

The lucid driver needs its table; `node ace configure @adonis-agora/telescope`
publishes it next to the config:

```sh
node ace migration:run   # create_telescope_entries_table (+ indexes on created_at/type/trace_id/family_hash)
```

Source: `docs/concepts/storage.mdx`, `docs/packages/storages.mdx`.

## Core patterns

### Pattern 1 — query the store through TelescopeService

Every set field of `EntryQuery` is an AND predicate; results are always
newest-first.

```ts
import { TelescopeService } from '@adonis-agora/telescope'

const telescope = await app.container.make(TelescopeService)
await telescope.list({ type: 'query', search: 'users', limit: 50 })
await telescope.list({ tag: 'status:500', after: oneHourAgo })
await telescope.list({ familyHash: 'billing:invoice-paid' })
```

Source: `docs/concepts/storage.mdx` (Querying).

### Pattern 2 — redaction and per-type bounds

Redaction is **on by default** at the one boundary every watcher records through —
the store's `record()` — so no watcher can bypass it. Sensitive keys
(`authorization`, `cookie`, `password`, `token`, `secret`, …) are masked with
`[REDACTED]` case-insensitively at any depth; the clone is also memory-bounded and
cycle-safe.

```ts
// config/telescope.ts
export default defineConfig({
  redact: {
    enabled: true,
    keys: ['ssn', 'credit_card'],                       // merged with the built-in set
    // perType raises only the NUMERIC bounds for one type — masking stays uniform:
    perType: { exception: { maxContentBytes: 64_000 } },
  },
})
```

The same `redact()` function is exported to scrub a value before building custom
content yourself.

Source: `docs/reference/configuration.mdx` (redact callout),
`docs/recipes/tags-and-redaction.mdx` (Built-in redaction).

### Pattern 3 — tail-sample noisy types without losing errors

`sampling` runs on the write path. A bare number is a uniform keep-rate; per-type
rules keep everything that looks like an error or is slow, no matter the rate.

```ts
export default defineConfig({
  sampling: {
    default: 1,                                   // keep everything by default
    cache: 0.1,                                   // a tenth of cache entries
    request: { rate: 0.25, keepErrors: true, keepSlowMs: 500 },  // but all errors/slow
  },
})
```

Sampled-out entries are never persisted, and the dashboard's retention indicator
shows which types record below 100% so counts aren't misread.

Source: `docs/recipes/tags-and-redaction.mdx` (Sampling),
`docs/packages/ui.mdx` (Retention endpoint).

### Pattern 4 — pause capture around bulk work

`setTelescopePaused(true)` flips the same flag the overload guard uses; every
ingestion point honours it immediately.

```ts
import { setTelescopePaused } from '@adonis-agora/telescope'

setTelescopePaused(true)
try {
  await importEverything()
} finally {
  setTelescopePaused(false)   // always restore: process-global, nothing else flips it back
}
```

Source: `docs/concepts/protection.mdx` (Pausing on purpose).

### Pattern 5 — a custom store

Implement the six-method contract and pass an instance as `store`. Two
responsibilities are easy to miss: `record` must resolve `traceId`/`origin`, and
`search` needs serialized content text.

```ts
import {
  currentTraceId, isBatchOrigin,
  type BatchOrigin, type Entry, type EntryQuery,
  type RecordInput, type TelescopeStore,
} from '@adonis-agora/telescope'
import { randomUUID } from 'node:crypto'

export class MongoTelescopeStore implements TelescopeStore {
  async record<T>(input: RecordInput<T>): Promise<Entry<T>> {
    const traceId = input.traceId !== undefined ? input.traceId : currentTraceId()
    const origin: BatchOrigin = isBatchOrigin(input.origin) ? input.origin : 'manual'
    const entry: Entry<T> = {
      id: randomUUID(), type: input.type, familyHash: input.familyHash ?? null,
      content: input.content, tags: input.tags ?? [], sequence: this.sequence++,
      durationMs: input.durationMs ?? null, origin, traceId, createdAt: new Date(),
    }
    await this.col.insertOne({ ...entry, createdAtMs: entry.createdAt.getTime(),
                               contentText: JSON.stringify(entry.content) }) // search target
    return entry
  }
  /* get / list / count / prune(olderThan, keepLast?) / clear */
}

// config/telescope.ts
export default defineConfig({ store: new MongoTelescopeStore(col) })
```

Source: `docs/recipes/custom-storage.mdx`.

## Common mistakes

### HIGH Shipping the memory driver to production

```ts
// Wrong — per-process ring buffer, lost on every restart/deploy; in a cluster each
// worker shows a different slice of reality.
defineConfig({ store: 'memory', stores: { memory: storage.memory({ limit: 1000 }) } })
```

```ts
// Correct — durable, cross-query storage via the built-in Lucid driver.
defineConfig({ store: 'lucid', stores: { lucid: storage.lucid() } })
```

Mechanism: eviction past the cap drops the oldest entries and nothing survives a
restart, so "nothing here" after a deploy is indistinguishable from "nothing
happened".
Source: `docs/concepts/storage.mdx` (memory driver warn).

### HIGH Switching to lucid without arming retention

```ts
// Wrong — a persistent SQL table with no time-based bound grows forever.
defineConfig({ store: 'lucid', stores: { lucid: storage.lucid() } })
```

```ts
// Correct — supply a prune block; that is what arms the background pruner.
defineConfig({
  store: 'lucid',
  stores: { lucid: storage.lucid() },
  prune: { after: '24h', keepLast: 50_000 },
})
```

Mechanism: no store auto-prunes by age (the memory driver evicts by count, the
lucid store never auto-evicts because that would add a query per write); the
pruner exists only when a `prune` block is supplied.
Source: `docs/concepts/protection.mdx` (info callout), `docs/packages/storages.mdx` (warn).

### HIGH Custom store skipping traceId/origin resolution

```ts
// Wrong — traceId left undefined and origin unvalidated:
traceId: input.traceId, origin: input.origin as BatchOrigin,
```

```ts
// Correct — explicit null respected, omitted reads context, junk falls back:
const traceId = input.traceId !== undefined ? input.traceId : currentTraceId()
const origin: BatchOrigin = isBatchOrigin(input.origin) ? input.origin : 'manual'
```

Mechanism: skipping this silently breaks trace correlation for everything
downstream (`byTrace`, waterfalls, N+1 detection) while every write still succeeds.
Source: `docs/recipes/custom-storage.mdx` (load-bearing lines).

### MEDIUM Importing services/db inside a provider's boot()

```ts
// Wrong — the facade default export is undefined until app.booted(), which runs
// AFTER provider boot.
import db from '@adonisjs/lucid/services/db'
const store = new LucidTelescopeStore(db)
```

```ts
// Correct — resolve the binding from the container during boot.
const db = await app.container.make('lucid.db')
const store = new LucidTelescopeStore(db, { tableName: 'telescope_entries' })
```

Mechanism: provider boot precedes `app.booted()`; resolving lazily through the
container gets the live binding instead of `undefined`.
Source: `docs/packages/storages.mdx` (Programmatic API note).

### MEDIUM Treating sampling as a security control

```ts
// Wrong — assuming dropping 90% of queries hides the secrets in the other 10%.
sampling: { query: 0.1 }
```

```ts
// Correct — scrub at the store boundary (always on); sample only for retention cost.
redact: { keys: ['ssn'] },
sampling: { query: { rate: 0.1, keepErrors: true } },
```

Mechanism: sampling decides what gets *stored*, not what gets *scrubbed*; redaction
runs on every recorded entry regardless of rate.
Source: `docs/packages/advanced.mdx` (sampling warn callout).

### MEDIUM Misreading prune keepLast semantics

```ts
// Wrong — assuming keepLast caps the WHOLE table at N rows.
await store.prune(cutoff, 500)   // expected: table trimmed to newest 500 overall
```

```ts
// Correct — keepLast retains the newest N of the matched-and-doomed set:
const deleted = await store.prune(cutoff, 500) // deletes older-than-cutoff EXCEPT its newest 500
```

Mechanism: the doomed set is computed first (everything older than cutoff), then
its newest `keepLast` survive; total row count can exceed `keepLast`.
Source: `docs/concepts/storage.mdx` (Retention and pruning).

See also: `telescope-watchers/SKILL.md` — the capture side these bounds protect;
`telescope-alerts-ai/SKILL.md` — why sampled-out exceptions never page.
