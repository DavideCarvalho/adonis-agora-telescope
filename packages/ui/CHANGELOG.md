# @adonis-agora/telescope-ui

## 1.1.3

### Patch Changes

- [#38](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/38) [`2c15898`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/2c1589856f0e58afd3bd4d33ab6a266fcf938bb6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: survives a nonce CSP.
  
  The provider used to hand the SPA its JSON API base as an inline `<script>` setting
  `window.__TELESCOPE_DASHBOARD_BASE__`. A host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
  `@nonce`, the recommended setup) drops that script silently; the SPA then derived a base from its own
  URL — right for the usual `<mount>/api` layout, but every request 404s on a custom one, from a
  console that rendered perfectly well. `injectApiBase` now emits a `<script type="application/json">`
  data block, which is never executed and so cannot be refused, and `resolveApiBase` reads it first
  (the global is still honoured after it). Nothing to change on the host.

## 1.1.2

### Patch Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/36) [`ac10e00`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/ac10e00db3252fce285bd57f9c40a17c2eaec2bd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - UI rebuilt on Tailwind 4, React 19 and Vite 8 — same tokens and layout; opacity modifiers now
  resolve through `color-mix` instead of the old colour-function trick.

## 1.1.1

### Patch Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/34) [`7565d6e`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7565d6eb5227ce039d8af2abd7e81011b1cc145f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: request entries agora carregam tag `user:<id>` (Pulse load-by-user); UI: botão Back in-app preserva contexto via history (fallback pra seção) + teste App-level de navegação por hash

## 1.1.0

### Minor Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/32) [`91e701a`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/91e701ab8f22f7546d0a41416de24debfb2dffaf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: request entries capturam o usuário autenticado (`ctx.auth.user` → `id`/`email`, defensivo) com `userLabel` nas projeções de entries/traces; UI mostra o usuário em detail/trace/listas, navegação por hash routes com deep links (`#/entries/:id`, `#/traces/:id`, `#/entries?type=`, ...) e contenção de overflow horizontal no content de exception

## 1.0.3

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/30) [`ede467a`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/ede467ac92daa97b829129751f01a41bea759329) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add TanStack Intent AI-agent skills. Ship six SKILL.md guides inside both published
  packages (`packages/*/skills/**`, now included in the `files` array): five core
  skills for `@adonis-agora/telescope` (setup, watchers, storage/retention,
  alerts/AI/client-errors, dashboard access control + MCP) and one for
  `@adonis-agora/telescope-ui` (the React console + `/client`). Adds
  `_artifacts/` domain map, skill spec and skill tree at the repo root, a
  `tanstack-intent` keyword and `@tanstack/intent` devDependency to both packages,
  and an `.github/workflows/check-skills.yml` CI validation workflow.

## 1.0.2

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/26) [`c53ba37`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/c53ba37e54418504fd39f3608e91ac6e9c76567d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop pinning 0.x peers with a caret, which npm rejects outright.

  Below 1.0 a caret does not cross a minor: `^0.32.0` means `>=0.32.0 <0.33.0`. pnpm downgrades an
  unsatisfied peer to a warning, so a workspace never notices — but **npm answers `ERESOLVE` and
  refuses to install**, and an optional peer that IS present must still match.

  `@adonis-agora/telescope` declared `"@anthropic-ai/sdk": "^0.32.0"`, which was **already broken**:
  installing it alongside any current SDK failed.

  ```
  While resolving: @adonis-agora/telescope@0.8.1
  Found: @anthropic-ai/sdk@0.116.0
  Conflicting peer dependency: @anthropic-ai/sdk@0.32.1
  ```

  It now declares `>=0.32.0 <1.0.0` — the same floor, verified to compile against every SDK minor
  from 0.32.0 through 0.116.0, with an upper bound that stops excluding them.

  `@adonis-agora/telescope-ui` declared `"@adonis-agora/telescope": "^0.8.0"`, the same defect one
  release from biting: satisfied by telescope 0.8.1 today, unsatisfiable the moment telescope cuts
  0.9.0. It now declares `>=0.7.0 <1.0.0`. The floor is 0.7.0 because that is the first release
  serving every route this console calls — `/api/retention`, `/api/profiles*`, `/api/queues/live*`,
  `/api/schedules/live` and `/api/exceptions/:id/diagnose` — not 0.5.0, which is merely where the
  provider still type-checks and where the console's Profiles, Queues, Schedules and retention
  sections would all 404.

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
