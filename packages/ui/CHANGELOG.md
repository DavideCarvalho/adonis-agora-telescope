# @adonis-agora/telescope-ui

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
