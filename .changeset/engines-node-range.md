---
'@adonis-agora/telescope': patch
'@adonis-agora/telescope-ui': patch
---

Publish a Node.js engine RANGE instead of one exact version. Both packages declared
`engines.node: "v26.7.0"` — a single pinned build, apparently a pasted `node -v`. Every install
on any other Node emitted an engine warning, and an `engine-strict` install failed outright. Both
now declare `>=20.6.0`, the version the code actually requires.
