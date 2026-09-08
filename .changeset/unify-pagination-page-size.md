---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

**Breaking:** every paginated surface now speaks the ecosystem's `{ page, size }` pagination
pair — `limit` is gone from the query/wire shapes, and the store's 0-based `offset` is gone with
it (the offset is derived as `(page - 1) * size`)

Telescope was paginating two different ways at once: the **store** took `{ limit, offset }`
(0-based skip) while the **HTTP API** took `?limit=&page=` (1-based) and converted between them
in the middle. Neither matched [`@adonis-agora/filter`](https://github.com/DavideCarvalho/adonis-agora-filter),
whose `FilterInput` is `{ page (1-based), size }`. Every `@adonis-agora/*` library is being moved
onto that one shape so a page of runs, a page of entries and a page of filtered rows are all
requested identically. The shape is matched **structurally** — `@adonis-agora/filter` is
deliberately NOT a dependency of this package.

Defaults and caps are unchanged: `size` still defaults to `50` and is still capped at `500` on
`GET /api/entries`; `page` defaults to `1`.

### Migration

```diff
  // 1. Store / service queries (@adonis-agora/telescope)
- await telescope.list({ type: 'request', limit: 25 })            // first page
- await telescope.list({ type: 'request', limit: 25, offset: 25 })// second page
+ await telescope.list({ type: 'request', size: 25 })             // first page
+ await telescope.list({ type: 'request', size: 25, page: 2 })    // second page

  // 2. HTTP API
- GET /telescope/api/entries?type=exception&limit=20&page=2
+ GET /telescope/api/entries?type=exception&size=20&page=2
- GET /telescope/api/metrics/traces?limit=25&page=2
+ GET /telescope/api/metrics/traces?size=25&page=2

  // 3. Browser client (@adonis-agora/telescope-ui/client)
- new TelescopeClient({ limit: 100 })
+ new TelescopeClient({ size: 100 })
- await client.listEntries({ type: 'exception', limit: 20 })
+ await client.listEntries({ type: 'exception', size: 20 })
  await client.traces(25)         // arg is now the page size, same call shape
  await client.tracesPage(25, 2)  // (size, page), same call shape

  // 4. Custom TelescopeStore implementations
  async list(query: EntryQuery = {}) {
-   if (query.limit !== undefined) cursor = cursor.limit(query.limit)
-   if (query.offset !== undefined) cursor = cursor.skip(query.offset)
+   if (query.size !== undefined) {
+     cursor = cursor.skip((Math.max(1, query.page ?? 1) - 1) * query.size).limit(query.size)
+   }
  }
  // ...same for the optional `listTraceIds(query)`: `{ limit, offset }` → `{ size, page }`.

  // 5. Extension paged-table providers (`{ kind: 'table', paged: true }`)
  async resolve(query) {
    const page = Math.max(1, Number(query?.page ?? 1))
-   const limit = Math.max(1, Number(query?.limit ?? 25))
-   return { rows, total, page, limit }
+   const size = Math.max(1, Number(query?.size ?? 25))
+   return { rows, total, page, size }
  }
```

Also renamed alongside the above: `EntryQuery.limit/offset` → `page/size`, `TraceIdQuery.limit/
offset` → `size/page`, `MetricsService.getTraces(limit, offset)` → `getTraces(size, page)` (page
is 1-based), `PagedTableData.limit`/`TablePagination.limit` → `.size`, and the list endpoint's
`meta.limit` → `meta.size`.

`MetricsService.getTracesPage(size, page)` is new and additive: it returns
`{ rows, hasMore }` for a Prev/Next pager. With the offset derived from `(page - 1) * size`, the
old "ask for one extra row" trick would have shifted the offset too, so `hasMore` is now a
one-row probe at the next page's offset — and it is skipped entirely for a short page.

**Not renamed**, because they cap a result set rather than page it: `storage.memory({ limit })`
(ring-buffer capacity), `?limit=` on `/api/stats`, `/api/metrics/screens` and `/api/profiles`,
the `topN` panel's `limit`, and the MCP `list_entries` tool's `limit` argument.
