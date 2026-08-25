# Design — user-aware traces, durable screen, hash routing, exception-content overflow

> Validated 2026-08-25 with the maintainer. Follows feedback on the live dashboard at
> `entretextosassessoria.com.br/telescope`: (1) traces don't say who the user is, (2) no durable
> screen, (3) exception content overflows the viewport, (4) no URL/hash routing (Aviary-style deep
> links). Delivery: edit lib + wire the entre-textos app, release via the lib's own CI, bump the app.

## Scope

- **`@adonis-agora/telescope`** (packages/core) — capture the authenticated user on request entries
  and expose it in list/trace projections.
- **`@adonis-agora/telescope-ui`** (packages/ui) — show the user, fix the exception-content overflow,
  replace state-based section switching with a dependency-light hash router.
- **entre-textos app** (this workspace) — wire `durableTelescopeExtension()` and bump the two
  telescope deps to the released versions.
- **Release** — changesets + the lib's own `release.yml` (changesets/action) to bump and publish;
  no local `changeset publish`.

## 1. User-aware traces

### Core

- `RequestEntryContent` gains `user: { id: string; email?: string } | null`, default `null`.
  The redaction pass (sensitive keys) does not touch `id`/`email`.
- `TelescopeMiddleware` reads the authenticated user defensively (try/catch, optional `ctx.auth`
  accessor) and extracts only `id` + `email`, passed through `recordRequest` options into the
  request entry content.
- `EntrySummary` (`ui/api.ts`) and `TraceSummary` (`metrics/traces.ts`) gain an optional
  `userLabel` (`email ?? id`) derived from the request entry's content — so lists can show it
  without a schema change.
- **No migration**: `content` is JSON; pre-existing entries simply carry `user: null`/no label.

### UI

- `EntryDetail`: a "User" row in the Details panel for request entries.
- `TraceDetail`: show the user in the trace header (resolved from the trace's request entry).
- `EntriesSection` / `TracesSection`: a User column in the list rows.

## 2. Durable screen (app wiring only)

- `@adonis-agora/durable/telescope` already exports `durableTelescopeExtension()` (a "Workflows"
  entry type + a golden-signals dashboard + 9 data providers). It is not wired in the app.
- `apps/entre-textos/config/telescope.ts`: add `extensions: [durableTelescopeExtension()]`.
- The app already runs the `diagnostics` watcher, so durable engine events flow in via
  `tag: 'lib:durable'` entries and the dashboard populates.

## 3. Exception-content overflow (UI layout hardening)

- Reproduce the exact overflowing surface locally before finalizing the fix.
- Expected hardening, applied to the exception detail surface:
  - `min-w-0` on the `md:grid-cols-[2fr_1fr]` children in `EntryDetail` so a wide code block can
    shrink instead of pushing the page right.
  - `max-w-full` + `overflow-x-auto` on `pre`/code blocks; `overflow-x-hidden` on `main`.
  - Table containment: scroll wrapper or ellipsis on long message cells (ExceptionsSection).

## 4. Hash routing (UI, no new dependency)

- New `useHashRoute` hook: parse `window.location.hash`, subscribe to `hashchange`, navigate by
  writing the hash. No router dependency (the package stays dependency-light).
- Routes:
  - `#/overview`, `#/pulse`, `#/entries`, `#/entries?type=<watcher>`, `#/entries/:id`,
    `#/traces`, `#/traces/:traceId`, `#/exceptions`, `#/queues`, `#/schedules`, `#/exports`,
    `#/profiles`, `#/extensions/:dashboardId`.
- `App.tsx` derives section/entry/trace/type-preset/dashboard from the route. The entry-preset
  `nonce` hack disappears (the `?type=` in the hash drives re-mount via key).
- Back/forward, refresh, and deep links work natively. No hash → `#/overview`. Theme stays in
  localStorage.

## 5. Release + app bump

- Lib: two changesets (core minor, ui minor). Local gates before commit: `pnpm typecheck`, `pnpm
  test`, `pnpm lint`, `pnpm build`.
- Push to the lib repo + PR to `master`; CI (`ci.yml`) runs. After merge, run `release.yml`
  (`gh workflow run release.yml`) → changesets/action opens the "chore: version packages" PR →
  merge → run again → publishes via OIDC trusted publishing.
- App: bump `@adonis-agora/telescope` and `@adonis-agora/telescope-ui` to the released versions,
  wire the durable extension, commit on a branch (no push — `main` auto-deploys).

## Non-goals

- No user capture on non-request entry types (queries, durable, logs) — the trace root carries it.
- No publish path besides the lib CI (no local `changeset publish`).
- No change to `@adonis-agora/durable` itself.