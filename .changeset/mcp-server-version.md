---
'@adonis-agora/telescope': patch
---

Report the real package version over MCP. The `initialize` handshake advertised a hardcoded
`0.4.0` regardless of the installed version; it now reads the package's own `VERSION`, which
the release pipeline keeps in lockstep with `package.json`.
