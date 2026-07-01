---
"@adonis-agora/telescope": patch
---

Fix stale `VERSION` exports in the sub-entry barrels (`ui`, `watchers`, `ai`,
`alerts`), which had drifted to `0.3.1` while the package shipped `0.3.2`.
`scripts/sync-version.mjs` now walks every `.ts` under `src/` (not just the
top-level `index.ts`), so its `--check` guard covers the nested literals and
they can no longer silently re-drift on a release bump.
