---
"@adonis-agora/telescope": patch
---

Cheaper recording on the hot path:

- The in-memory store appends and evicts in O(1) amortized time instead of `unshift` + `pop`, which moved every retained entry on each write (≈73 µs → ≈2 µs per record at `maxEntries: 100000`).
- Query family hashes are memoized per SQL string (bounded at 2,000 statements up to 4 KiB each), so each recorded query skips three regex passes (≈1.9 µs → ≈0.08 µs).
- Redaction builds dotted key paths only when `redact.paths` is configured, roughly halving the walk cost for a typical request entry.
- The middleware's dashboard-path check no longer allocates a split array per request.
