---
'@adonis-agora/telescope': patch
---

`new LucidTelescopeStore(db)` compiles with a real Lucid `Database`, connection or transaction client, as `docs/packages/storages.mdx` shows: the constructor takes the new exported `LucidClientLike` (Lucid's overloaded query-builder types never matched the structural `LucidDatabaseLike`, which the store still reads it through).
