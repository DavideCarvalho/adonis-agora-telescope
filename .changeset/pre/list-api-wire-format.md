---
"@adonis-agora/telescope": major
"@adonis-agora/telescope-ui": major
---

List endpoints speak the `@adonis-agora/filter` list format.

- `GET <path>/api/entries`: filters are `filter[type]`, `filter[tag]` (one or several), `filter[traceId]` (one or several), `filter[familyHash]`, `filter[createdAt][gt|gte|lt|lte|between]`, plus `search`; `sort` accepts only `-createdAt`; paging is a forward cursor (`after` + `first`, default 50, max 500). The response is `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The flat `type`/`tag`/`traceId` params, `before` (ISO date), `page`, `size` and the old `meta` (`count`, `page`, `size`, `hasMore`, `query`) are gone. An unknown filter field or operator, another sort, a `before` cursor or a malformed cursor answers `400`.
- `GET <path>/api/metrics/traces`: cursor paging both ways (`after`/`first`, `before`/`last`), `sort=-lastAt` only, no filters; same cursor envelope. `page`/`size` and `meta.hasMore` are gone.
- `GET <path>/api/profiles`: forward cursor (`after` + `first`, default 100) in the cursor envelope; `limit` is gone.
- Paged extension tables (`paged: true`): the provider returns the offset envelope `{ data: rows, meta: { total, perPage, currentPage, lastPage, firstPage } }` (`offsetPage` from `@adonis-agora/filter`) instead of `{ rows, total, page, size }`. `PagedTableData` is now `OffsetPage<Record<string, unknown>>`, and `tablePagination` reads it.
- `buildQuery` is removed from `@adonis-agora/telescope/ui`; `parseEntryListRequest`, `readEntryPage`, `entryFeedPage`, `parseTraceListRequest`, `EntryFilter`, `NoFilter`, `EntryQueryDraft`, `rejectList` and the cursor encoders are exported instead.
- `@adonis-agora/telescope-ui/client`: `EntriesQuery` is `{ type, tag, traceId, search, after, first }` (no `before`, `page`, `size`); `listEntriesPage` and `tracesPage({ after, before, first })` resolve to `CursorPageResponse<T>`; `traces(first)` and `profiles(first)` take the page size; the `Page<T>` type is removed and `CursorPageResponse`, `CursorPageMeta`, `OffsetPage`, `OffsetPageMeta`, `TracesCursor`, `PagedTablePanelData` are exported. `TablePanelData` no longer carries `total`/`page`/`size`.
