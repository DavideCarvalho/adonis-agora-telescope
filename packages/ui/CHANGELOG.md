# @adonis-agora/telescope-ui

## 1.0.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish a Node.js engine RANGE instead of one exact version. Both packages declared
  `engines.node: "v26.7.0"` — a single pinned build, written by a renovate "pin dependencies" run
  that treated a compatibility range as a version to pin. Every install
  on any other Node emitted an engine warning, and an `engine-strict` install failed outright. Both
  now declare `>=20.6.0`, the version the code actually requires, and renovate is configured to
  leave `engines` alone so the fix survives the next cycle.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correct the package description. It advertised a "dependency-light React SPA" with five views;
  the published package depends on Base UI, `class-variance-authority`, `clsx` and `tailwind-merge`
  and is built with Tailwind CSS, and the console has grown an overview, CPU profiles, live queue
  and schedule consoles, extension pages and client-side exports. The description now says so, and
  notes that the `/client` subpath remains a dependency-free fetch client.

## 1.0.0

### Patch Changes

- Updated dependencies [[`13bc033`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/13bc033fb8bcac304e949a90716a6210677bb94d)]:
  - @adonis-agora/telescope@0.8.0

## 0.3.0

### Minor Changes

- [`7f39834`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7f39834570c1bd998b187bcf2024270b15698a72) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Rebuilt the dashboard shell to match `@dudousxd/nestjs-telescope-ui`'s actual visual structure: a
  left sidebar nav (with a dynamic Watchers sub-nav, including extension-contributed entry types like
  `adonis-durable`'s "Workflows") replacing the top pill-tab bar, a compact single-line header
  (retention indicator, `⌘K` hint, theme toggle, live status pill), monospace typography across the
  whole shell instead of only numeric values, a flat black background (dropped the dotted/grid
  overlay), and denser panel spacing/corner-radius.

  Added the missing "Overview" landing page (stat cards, recent failures, N+1/queue/job hotspots,
  throughput + by-type breakdown, and retention posture) and filled in the previously-missing
  "Entries by type" and "Slow outgoing HTTP" sections on the Pulse page. No feature/API changes —
  existing sections (command palette, AI diagnosis, request replay, exports, live queue manager,
  live schedules, CPU flamegraph) are unchanged, just re-laid-out.

## 0.2.0

### Minor Changes

- [`e32ce15`](https://github.com/DavideCarvalho/adonis-telescope/commit/e32ce15382dd15119aa672df6c1d200008025ae7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: Tailwind + Base UI + CVA visual migration, plus command palette, extensions dashboard, N+1 hotspots, exports, and live views for the new backend capabilities

  A visual refresh of the entire dashboard SPA — hand-rolled CSS replaced with Tailwind CSS, `@base-ui-components/react` primitives, and `class-variance-authority` variants, matching the nestjs-telescope sibling's brand tokens (magenta accent). This is a styling/markup migration, not an API change: existing routes, props, and the `@adonis-agora/telescope/client` surface are unaffected.

  New UI surfaced alongside the migration:

  - **AI exception diagnosis panel**, wired to the core's new `POST .../exceptions/:id/diagnose` route.
  - **Request replay UI**, wired to the existing `POST .../requests/:id/replay` route (no backend change).
  - **Command palette** (`CommandPalette.tsx`) for quick navigation.
  - **Extensions dashboard** section listing extension-contributed data.
  - **N+1 hotspots** tab surfacing the existing `/api/metrics/n-plus-one/:traceId` analysis.
  - **Exports section** (`ExportsSection.tsx` + a new `client/export.ts` helper).
  - **Retention indicator**, wired to the core's new `GET .../api/retention` route.
  - **Live Queue Manager UI** (`QueueManagerSection.tsx`) and **Live Schedules UI** (`SchedulesLiveSection.tsx`), wired to their respective new core routes.
  - **CPU flamegraph views** (`Flamegraph.tsx`, `ProfilesSection.tsx`), wired to the new `/api/profiles/*` routes.
  - Theme persistence (light/dark) across reloads.

  New runtime dependencies for the SPA bundle: `@base-ui-components/react`, `class-variance-authority`, `clsx`, `tailwind-merge` (all bundled by the existing Vite build, not new peer requirements for consumers).

### Patch Changes

- [`e32ce15`](https://github.com/DavideCarvalho/adonis-telescope/commit/e32ce15382dd15119aa672df6c1d200008025ae7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen the `@adonis-agora/telescope` peer range to accept `0.7` (this release's core additions — diagnosis wiring, retention endpoint, queue manager, schedules, CPU profiling — are additive; the UI is compatible).

## 0.1.3

### Patch Changes

- Widen the `@adonis-agora/telescope` peer range to accept `0.6` (the parity-sync minor is additive; the UI is compatible).
