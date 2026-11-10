---
"@adonis-agora/telescope": major
---

First stable release. No public API was removed or renamed: code written against 0.27 runs unchanged.

Breaking changes:

- The version line moves from `0.x` to `1.x`. A range such as `^0.27.1` does not match `1.0.0`, so update it to `^1.0.0`.
- Node.js 24 or newer is required (`engines.node: ">=24"`).

See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/telescope/reference/migrating-to-1-0).
