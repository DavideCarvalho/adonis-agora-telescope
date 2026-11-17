---
'@adonis-agora/telescope': minor
---

Knobs to record fewer entries on busy apps. Defaults are unchanged (everything is recorded).

- `query.sampleRate` (0..1) keeps the queries of that fraction of traces — a kept request keeps all of its queries, so its timeline and N+1 detection stay complete — and `query.minMs` skips queries faster than the given ms. Queries at/above `slowMs` and failed queries are always recorded.
- Failed Lucid queries are now tagged `failed` and carry the error message in `content.error`.
- `cache.hitSampleRate` (0..1, per trace) samples cache hits; misses, writes, deletes and clears are always recorded. `cache.ignoreStores` and `cache.ignoreKeys` (prefixes / RegExps) drop operations on those stores or keys.
- `ignoreRequestPaths` in `config/telescope.ts` (segment-boundary prefixes / RegExps) keeps the request watcher from recording those paths.
