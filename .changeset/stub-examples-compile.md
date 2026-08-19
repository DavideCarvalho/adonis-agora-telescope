---
'@adonis-agora/telescope': patch
---

Make the commented-out examples in the published config stubs actually compile.

Every `config/telescope_*.ts` stub documents its options as a commented block you uncomment. Three
of those blocks did not type-check the moment you did:

- `config/telescope_ui.ts`, `config/telescope_mcp.ts` and `config/telescope_alerts.ts` used
  `env.get(...)` in their examples without importing `env` — uncommenting one gave
  `Cannot find name 'env'`. Each now carries a commented `import env from '#start/env'` next to the
  examples that need it.
- The `authorize` example read `ctx.auth?.user?.isAdmin`, but the hook's declared parameter is the
  framework-light `{ request, response }` slice, so `auth` is not on the type (the provider does
  pass your real `HttpContext` through at runtime). The example now narrows `ctx` explicitly, which
  is both correct and honest about why the cast is there.
- The `geoLookup` example did `const body = await res.json()`, which is `unknown` — every
  `body.city` read was an error. It is now typed at the boundary.

The same four fixes are applied to the docs, which carried the identical examples.

A new test compiles every published stub inside a scratch consumer app — with the package resolved
by name, so against the shipped `dist/**/*.d.ts` — and compiles a second copy of each config stub
with every commented example switched on. Across the seven config stubs there are 28 lines of live
code and 101 commented ones, so without that second pass the gate would have been watching under a
quarter of what these files document.

`copy:stubs` also now copies the stubs directory wholesale instead of naming each of the eight files
in a chained `cp`, so an added stub can no longer be published as a missing file.
