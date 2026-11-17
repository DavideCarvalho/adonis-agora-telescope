---
"@adonis-agora/telescope": minor
---

Traces screen: pages by keyset instead of grouping the whole entries table.

- `GET /api/metrics/traces` no longer runs `GROUP BY trace_id` over every stored entry (twice per page, with the next-page probe). The lucid store walks the entries newest-first on the `created_at` index until it has the page, then reads the page's traces by `trace_id`. On a 4.3M-row table a page reads about 1–4k buffers instead of about 445k (≈3.4 GB), whatever its depth. No new index.
- The console's `?app=` view gets the same path: a scoped view used to read the newest 50,000 entries with their content twice per page, and could not reach older traces.
- The next-page cursor carries the last trace shown, so a trace that became active again is not shown twice. Cursors issued before keep working (they page by position), and the response is unchanged.
- New optional store read `pageTraceIds({ size, cursor?, tagGroups? })`, implemented by the lucid and memory stores and exposed by the store decorators. Custom stores without it keep the old path.
