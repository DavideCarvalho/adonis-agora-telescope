# @adonis-agora/telescope-ui

## 3.0.0-rc.7

### Major Changes

- [#308](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/308) [`8bafa12`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/8bafa126080e4b490265c450b29e6650cff16862) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - List endpoints speak the `@adonis-agora/filter` list format.
  
  - `GET <path>/api/entries`: filters are `filter[type]`, `filter[tag]` (one or several), `filter[traceId]` (one or several), `filter[familyHash]`, `filter[createdAt][gt|gte|lt|lte|between]`, plus `search`; `sort` accepts only `-createdAt`; paging is a forward cursor (`after` + `first`, default 50, max 500). The response is `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The flat `type`/`tag`/`traceId` params, `before` (ISO date), `page`, `size` and the old `meta` (`count`, `page`, `size`, `hasMore`, `query`) are gone. An unknown filter field or operator, another sort, a `before` cursor or a malformed cursor answers `400`.
  - `GET <path>/api/metrics/traces`: cursor paging both ways (`after`/`first`, `before`/`last`), `sort=-lastAt` only, no filters; same cursor envelope. `page`/`size` and `meta.hasMore` are gone.
  - `GET <path>/api/profiles`: forward cursor (`after` + `first`, default 100) in the cursor envelope; `limit` is gone.
  - Paged extension tables (`paged: true`): the provider returns the offset envelope `{ data: rows, meta: { total, perPage, currentPage, lastPage, firstPage } }` (`offsetPage` from `@adonis-agora/filter`) instead of `{ rows, total, page, size }`. `PagedTableData` is now `OffsetPage<Record<string, unknown>>`, and `tablePagination` reads it.
  - `buildQuery` is removed from `@adonis-agora/telescope/ui`; `parseEntryListRequest`, `readEntryPage`, `entryFeedPage`, `parseTraceListRequest`, `EntryFilter`, `NoFilter`, `EntryQueryDraft`, `rejectList` and the cursor encoders are exported instead.
  - `@adonis-agora/telescope-ui/client`: `EntriesQuery` is `{ type, tag, traceId, search, after, first }` (no `before`, `page`, `size`); `listEntriesPage` and `tracesPage({ after, before, first })` resolve to `CursorPageResponse<T>`; `traces(first)` and `profiles(first)` take the page size; the `Page<T>` type is removed and `CursorPageResponse`, `CursorPageMeta`, `OffsetPage`, `OffsetPageMeta`, `TracesCursor`, `PagedTablePanelData` are exported. `TablePanelData` no longer carries `total`/`page`/`size`.

## 3.0.0-rc.6

### Minor Changes

- [#295](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/295) [`60d460d`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/60d460d9d266f21b6633e4d008fc15edb87b9b46) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Organizations (tenancy). With `tenancy.enabled` in `config/context.ts`, every entry is tagged with the active organization (`tenant:<id>`, one tag per level of a nested tenant, `tenant:*` inside `Context.allTenants()`), and the console, JSON API, live tail, `/telescope/mcp` and the dev MCP tools show each viewer only the organizations its `authorize` grants: its own by default, or `{ allowed: true, tenants: [...] | '*' }`. Counts and groups are computed from those entries only. The console header gains an Organization picker (`?tenant=<id>`), and `authorizeByToken` takes `tenants`. New options: `tenancy: 'inherit' | false | { kinds, tag }` in `config/telescope.ts`; `EntryQuery.anyTags` on every store. Viewers limited to some organizations cannot run actions that reach all of them (CPU capture, queue actions, extension actions, Prometheus).

## 3.0.0-rc.5

### Minor Changes

- [#293](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/293) [`9cddf99`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/9cddf99ed9d7fa1efa85f55af7a9292b8235edac) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console switcher and global search. Telescope joins the shared `'agora.consoles'` registry (title "Telescope", order 20) with no config; when the app runs other Agora consoles, the sidebar brand becomes a menu of the ones the viewer may open (each decided by that console's own `authorize`), and the `⌘K` palette also searches Telescope entries (by id, trace id or text) and every other console the viewer may open. New routes: `GET <path>/api/consoles` and `GET <path>/api/consoles/search?q=`, behind the console `authorize`. While the switcher runs another console's gate, `ctx.agoraProbe` is `true`.

## 3.0.0-rc.4

### Minor Changes

- [#291](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/291) [`c5ea417`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/c5ea4174f1cadc3a442067f8177e365db4d9c707) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Libraries can plug their pages into Telescope with no app config: push a `TelescopeExtension` into the `'agora.telescope.extensions'` container binding from your provider's `register()` (create the array when absent). Telescope reads it at boot next to `config.extensions`; a configured extension with the same `name` wins.
  
  Extensions can also declare `actions`: server-side writes a table column triggers on its row (`column.action`), after a confirmation dialog. Every call runs behind the console's `authorize`, needs `{ confirmed: true }`, and is audited (log line + a `diagnostic` entry tagged `event:extension-action`). Console writes now send shield's `X-XSRF-TOKEN` header when the `XSRF-TOKEN` cookie is present.

## 3.0.0-rc.3

### Minor Changes

- [#290](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/290) [`671fde5`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/671fde560c2ae7ca8bd54e3c3a07170db576bf77) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Telescope works with `@adonisjs/otel` 2 in both directions, and no longer exports on its own.
  
  **OpenTelemetry spans in the trace view.** Add `telescopeSpanProcessor()` from `@adonis-agora/telescope/otel` to `spanProcessors` in `config/otel.ts`. The spans the app's instrumentation records (pg, outgoing http, DNS, events, `@span()` methods) are stored as `span` entries and show in the trace waterfall next to Telescope's own entries. Where a Telescope watcher already records the same operation with more detail (`request`, `query`, `redis`, `events`, and each `fetch` made through `instrumentFetch`), the OpenTelemetry span is skipped, along with the driver spans under it; with that watcher off, the span comes through instead. Telescope's own storage queries run with tracing suppressed, so they never show up as app spans. Sampling, retention, redaction and the overload guard apply, plus a per-trace cap (`maxSpansPerTrace`, default 200).
  
  ```ts
  // config/otel.ts
  import { defineConfig, destinations } from '@adonisjs/otel'
  import { telescopeSpanProcessor } from '@adonis-agora/telescope/otel'
  
  export default defineConfig({
    spanProcessors: [telescopeSpanProcessor()],
    destinations: { collector: destinations.otlp({ endpoint: 'http://localhost:4318' }) },
  })
  ```
  
  **One trace id.** When an OpenTelemetry SDK is running, every entry recorded inside a span takes that span's trace id, so Telescope entries and the app's spans share one trace.
  
  **Breaking: Telescope's own exporter is removed.** The `otel` block's `enabled`, `endpoint`, `tracesPath`, `logsPath`, `headers`, `serviceName` and `timeoutMs`, and the `otel.metrics` endpoint object, are gone with no alias; boot fails with a pointer to the migration guide while any of them is set. When the app runs `@adonisjs/otel`, Telescope sends its entries (spans for timed entries, log records otherwise) and the AI-usage metrics through the app's global providers, so endpoint and headers live in `config/otel.ts` only. Without `@adonisjs/otel` nothing is sent; everything is still recorded locally.
  
  `otel` now takes `{ entryTypes?, metrics? }` or `false`. `entryTypes` defaults to the types OpenTelemetry does not already trace (`diagnostic`, `exception`, `client_exception`, `job`, `scheduled_task`, `mail`, `cache`, `profile`). Entries other than diagnostics events are now mapped too (`telescope.<type>`, with `exception.*` attributes on exceptions).
  
  **Peers.** `@adonisjs/otel` `^2.0.0` is a new optional peer and `@opentelemetry/api` moves to `^1.10.0`. The `@opentelemetry/sdk-trace`, `sdk-trace-base`, `sdk-logs`, `sdk-metrics`, `resources` and `exporter-*-otlp-http` peers are dropped.
  
  The dashboard lists `span` entries as "OTel span".

## 3.0.0-rc.2

### Major Changes

- [#288](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/288) [`8c71af2`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/8c71af278573efb70730e13805434f527d3cb7af) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console has one access option, `telescope_ui.authorize`, shared with every `@adonis-agora` console.
  
  **Breaking: token and HTTP Basic access are removed.** `telescope_ui.credentials` (`{ token, basic }`), the `?token=` query string, the Basic prompt, `defaultAuthorize(...)` and the `UiCredentials` type are gone, so `TELESCOPE_UI_TOKEN` / `TELESCOPE_UI_PASSWORD` are no longer read. For token access use the new helper, which reads only `Authorization: Bearer <token>` (timing-safe) and answers `401` otherwise; an empty or missing token throws when the config loads:
  
  ```ts
  import { authorizeByToken, defineConfig } from '@adonis-agora/telescope/ui'
  
  export default defineConfig({
    authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
  })
  ```
  
  **Breaking: the default without `authorize`.** The console is open outside production (`app.inProduction === false`); in production every page and API request gets `403`. In every environment, one warning is logged at boot:
  `[@adonis-agora/telescope] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in config/telescope_ui.ts.`
  
  **Breaking: denial bodies.** The API answers `403 { error: 'forbidden' }`, `401 { error: 'unauthenticated' }`, and `401 { error: 'unauthenticated', redirectTo }` for `{ redirectTo }`. Pages keep the access-denied page; a `401` no longer sends a `WWW-Authenticate: Basic` challenge (the `challenge` page-guard option is gone).
  
  `authorize` takes three forms:
  
  - a function, typed with the real `HttpContext`: `authorize: (ctx) => ctx.auth.user?.isAdmin === true`;
  - an authorizer class, built through the container so `@inject()` works: `authorize: ConsoleAccess`;
  - a lazy import of that class: `authorize: () => import('#policies/console_access')` (imported once).
  
  It may return `true`/`false`, `{ allowed, reason? }` or `{ redirectTo: '/login' }` (a page navigation is redirected there with `302`). A thrown error is a `403`. `authorizeByToken`, `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` are exported from `@adonis-agora/telescope/ui`. `authorizeByRoles(...)` keeps working as it is.
  
  **Breaking: `dashboardAuth` is removed.** The console has no login of its own: the login page, the `<path>/login` / `<path>/logout` routes, the signed session cookie, the `login` hook (and its "dashboardAuth login hook threw" warning) are gone, with no alias. So are the exports `resolveDashboardAuth`, `performLogin`, `readSession`, `decideDashboardAuth`, `enforceDashboardAuth`, `sanitizeReturnTo`, `renderLoginPage`, `signSessionCookie`, `verifySessionCookie`, `readSessionCookie`, `writeSessionCookie`, `clearSessionCookie`, `SESSION_COOKIE_NAME`, the `DashboardAuthOptions` / `ResolvedDashboardAuth` / `DashboardSession` / `LoginHook` types, `PageGuardOptions.loginHref` and the access-denied page's `session-required` reason. `TELESCOPE_DASHBOARD_SECRET` is no longer read. People sign in through the app; `authorize` can return `{ redirectTo: '/login' }`, and `accessDenied.loginHref` points the access-denied page's "Sign in" button at the app's login.
  
  **Breaking: the MCP endpoint uses `authorize`.** `config/telescope_mcp.ts` no longer takes `credentials` (`{ token, basic }`), `?token=` or HTTP Basic, and the `McpCredentials` type is gone. `authorize` takes the same `ConsoleAuthorize` forms as the console; MCP clients use `authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') })`, now also exported from `@adonis-agora/telescope/mcp`. Without `authorize` the endpoint is open outside production and answers `403` in production, with one boot warning in every environment:
  `[@adonis-agora/telescope] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in config/telescope_mcp.ts.`
  A denial is a JSON response, `403 { error: 'forbidden' }` or `401 { error: 'unauthenticated' }`, instead of a `200` with a JSON-RPC `-32001` error. `resolveConfig` takes `{ inProduction }` as a second argument.
  
  See the 1.0 migration guide for before/after.
  
  `@adonis-agora/telescope-ui` serves its pages behind the same `authorize`, so the SPA follows the same default and denial handling. When an API call gets a `401`, the SPA follows the `redirectTo` it carries, or reloads the page so the server answers the navigation.

## 3.0.0-rc.1

### Patch Changes

- [#284](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/284) [`6030370`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/60303709e27787e3268905d55141a3dcabfe2e08) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix arming a CPU capture from the dashboard: `TelescopeClient#armProfile(count, label)` now sends `count` and `label` in the JSON request body, which is where the arm route reads them. Before, they went in the query string and every arm captured one request with no label.
  
  The overview no longer requests `<path>/api/queues/live` when `/meta` reports no queue manager, so an app without the `queue-manager` watcher stops logging a 404 on every overview load.

## 3.0.0-rc.0

### Major Changes

- [#281](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/281) [`c280462`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/c280462b8bdde40b9025168a98a53f9aee5e8728) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0: the 0.x leftovers are removed.
  
  Breaking changes in `@adonis-agora/telescope` (0.27 → 1.0):
  
  - The version line moves from `0.x` to `1.x`. A range such as `^0.27.1` does not match `1.0.0`, so update it to `^1.0.0`.
  - Node.js 24 or newer is required (`engines.node: ">=24"`).
  - `storage.memory({ limit })` is removed. Use `storage.memory({ maxEntries })`, which takes the same number. `MemoryStoreConfig` is now the same type as `InMemoryStoreOptions`.
  - `AiCoverage.legacyAgentLib` is removed from the AI metrics summary (`GET <path>/api/metrics/ai`, `MetricsService.getAi`, `summarizeAiUsage`). It flagged `@adonis-agora/agent` releases older than 0.93.0. `getAi` no longer runs the extra `lib:agent` probe when a window has no `usage.recorded`.
  
  Breaking changes in `@adonis-agora/telescope-ui` (2.x → 3.0):
  
  - The SPA no longer reads `window.__TELESCOPE_DASHBOARD_BASE__`. It takes the API base from the `telescope-dashboard-config` JSON data block the provider injects, or derives `<mount>/api` from the page URL. To point a hand-embedded client at another base, pass `new TelescopeClient({ baseUrl })`. `resolveApiBase(win, doc)` no longer accepts the global on `win`.
  - `AiCoverage.legacyAgentLib` is removed from the `/client` types, and the AI screen's "Not measured" notice for agent releases older than 0.93.0 is gone.
  - The `@adonis-agora/telescope` peer range is now `>=0.11.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0`, so the dashboard installs next to telescope 1.x, release candidates included.
  
  See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/telescope/reference/migrating-to-1-0).

## 2.1.0

### Minor Changes

- [#236](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/236) [`f916e2c`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/f916e2ca5a219903d1ff7fb79a1dadf3d7c1aeca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AI spend and agent run timings are first-class, from `@adonis-agora/agent` 0.93.0's `usage.recorded` and `run.*` events.
  
  - **AI screen** (`#/ai`, backed by `GET <path>/api/metrics/ai`): spend over a window (total, platform and estimated shares, over time, by feature / model / payer), agent runs with a queue / model / tools bar, the slowest and most expensive, a per-step breakdown linking to the run's trace, and the calls that carried no cost. When the app's agent lib predates these events, the screen says so instead of showing $0.
  - **Metrics** `agora_ai_cost_usd`, `agora_ai_tokens`, `agora_ai_audio_seconds`, `agora_ai_requests` (counters) and `agora_agent_run_duration_ms`, `_queue_ms`, `_model_ms`, `_tools_ms`, `agora_agent_tool_duration_ms` (histograms). Low-cardinality attributes only (never actor, run or thread). They are fed straight from the `agora:agent:*` channels, so sampling and retention never change a count.
  - **OTLP metrics**: `otel.metrics: { enabled, endpoint?, path?, headers?, exportIntervalMs? }`. It is opt-in, independent of traces/logs and can use its own endpoint. `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http` are new optional peers, imported only when it is on.
  - **Prometheus scrape**: `prometheus: { enabled: true }` serves `GET <path>/metrics` behind the same guard as the JSON API. It is off by default.
  - **Grafana**: an importable dashboard ships at `grafana/agora-ai-dashboard.json`.
  - **Fix**: client-paged dashboard tables (Screens, Exceptions) rendered every row; they page again.

## 2.0.2

### Patch Changes

- [#232](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/232) [`9541859`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/954185970647f820200421c5b8465800bfe2cee4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - perf(ui): split the dashboard SPA per section with `React.lazy`. The shell and the landing Overview load up front; every other section (Entries, Entry/Trace detail, Traces, Screens, Pulse, Exceptions, Queues, Schedules, Exports, Profiles, extension dashboards) is fetched the first time it is opened. Initial JS drops from 573 KB (178 KB gzip) to 481 KB (157 KB gzip). Lazy chunks resolve relative to the entry module (`base: './'` + `import.meta.url`), so they work under any mount prefix; a failed chunk import (e.g. a tab left open across a rolling deploy) triggers a single page reload to pick up the new build.

## 2.0.1

### Patch Changes

- [#229](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/229) [`0ba2c6e`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/0ba2c6e04bc595f98f7e85fd6331dd052e0369b9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The live tail batches incoming SSE frames into one state update per 100 ms instead of re-rendering the entries table for every frame, and the "new row" highlight uses a Set lookup instead of scanning the tail for each row.

## 2.0.0

### Major Changes

- [#184](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/184) [`01f7971`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/01f7971a23fe5f3ab0822e4377c89acb65cf10c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.

## 1.5.2

### Patch Changes

- fix(deps): update dependency @base-ui/react to v1.9.0 ([#172](https://github.com/DavideCarvalho/adonis-agora-telescope/issues/172))

## 1.5.1

### Patch Changes

- fix(deps): update dependency tailwind-merge to v3.7.0 ([#107](https://github.com/DavideCarvalho/adonis-agora-telescope/issues/107))

## 1.5.0

### Minor Changes

- [#88](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/88) [`4e22b5d`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/4e22b5d7add3869e1314d60f5b90602900780fef) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking:** every paginated surface now speaks the ecosystem's `{ page, size }` pagination
  pair — `limit` is gone from the query/wire shapes, and the store's 0-based `offset` is gone with
  it (the offset is derived as `(page - 1) * size`)
  
  Telescope was paginating two different ways at once: the **store** took `{ limit, offset }`
  (0-based skip) while the **HTTP API** took `?limit=&page=` (1-based) and converted between them
  in the middle. Neither matched [`@adonis-agora/filter`](https://github.com/DavideCarvalho/adonis-agora-filter),
  whose `FilterInput` is `{ page (1-based), size }`. Every `@adonis-agora/*` library is being moved
  onto that one shape so a page of runs, a page of entries and a page of filtered rows are all
  requested identically. The shape is matched **structurally** — `@adonis-agora/filter` is
  deliberately NOT a dependency of this package.
  
  Defaults and caps are unchanged: `size` still defaults to `50` and is still capped at `500` on
  `GET /api/entries`; `page` defaults to `1`.
  
  ### Migration
  
  ```diff
    // 1. Store / service queries (@adonis-agora/telescope)
  - await telescope.list({ type: 'request', limit: 25 })            // first page
  - await telescope.list({ type: 'request', limit: 25, offset: 25 })// second page
  + await telescope.list({ type: 'request', size: 25 })             // first page
  + await telescope.list({ type: 'request', size: 25, page: 2 })    // second page
  
    // 2. HTTP API
  - GET /telescope/api/entries?type=exception&limit=20&page=2
  + GET /telescope/api/entries?type=exception&size=20&page=2
  - GET /telescope/api/metrics/traces?limit=25&page=2
  + GET /telescope/api/metrics/traces?size=25&page=2
  
    // 3. Browser client (@adonis-agora/telescope-ui/client)
  - new TelescopeClient({ limit: 100 })
  + new TelescopeClient({ size: 100 })
  - await client.listEntries({ type: 'exception', limit: 20 })
  + await client.listEntries({ type: 'exception', size: 20 })
    await client.traces(25)         // arg is now the page size, same call shape
    await client.tracesPage(25, 2)  // (size, page), same call shape
  
    // 4. Custom TelescopeStore implementations
    async list(query: EntryQuery = {}) {
  -   if (query.limit !== undefined) cursor = cursor.limit(query.limit)
  -   if (query.offset !== undefined) cursor = cursor.skip(query.offset)
  +   if (query.size !== undefined) {
  +     cursor = cursor.skip((Math.max(1, query.page ?? 1) - 1) * query.size).limit(query.size)
  +   }
    }
    // ...same for the optional `listTraceIds(query)`: `{ limit, offset }` → `{ size, page }`.
  
    // 5. Extension paged-table providers (`{ kind: 'table', paged: true }`)
    async resolve(query) {
      const page = Math.max(1, Number(query?.page ?? 1))
  -   const limit = Math.max(1, Number(query?.limit ?? 25))
  -   return { rows, total, page, limit }
  +   const size = Math.max(1, Number(query?.size ?? 25))
  +   return { rows, total, page, size }
    }
  ```
  
  Also renamed alongside the above: `EntryQuery.limit/offset` → `page/size`, `TraceIdQuery.limit/
  offset` → `size/page`, `MetricsService.getTraces(limit, offset)` → `getTraces(size, page)` (page
  is 1-based), `PagedTableData.limit`/`TablePagination.limit` → `.size`, and the list endpoint's
  `meta.limit` → `meta.size`.
  
  `MetricsService.getTracesPage(size, page)` is new and additive: it returns
  `{ rows, hasMore }` for a Prev/Next pager. With the offset derived from `(page - 1) * size`, the
  old "ask for one extra row" trick would have shifted the offset too, so `hasMore` is now a
  one-row probe at the next page's offset — and it is skipped entirely for a short page.
  
  **Not renamed**, because they cap a result set rather than page it: `storage.memory({ limit })`
  (ring-buffer capacity), `?limit=` on `/api/stats`, `/api/metrics/screens` and `/api/profiles`,
  the `topN` panel's `limit`, and the MCP `list_entries` tool's `limit` argument.

### Patch Changes

- [#89](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/89) [`7fc5ecd`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7fc5ecd97e0470c18a15df1da81519c08ca74bbc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Routine dependency refresh. The only change that reaches a published manifest is `@base-ui/react` moving from `1.7.0` to `1.8.0` in `@adonis-agora/telescope-ui`'s runtime dependencies; everything else in the sweep is devDependency-only.

## 1.4.0

### Minor Changes

- [#66](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/66) [`a95bef1`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/a95bef1699d028860815d302eec81e444dce3af9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Live Schedules agora mostra o POOL que serve cada agenda
  
  `ScheduleRegistration` ganhou `pool?: string | null`, e ele atravessa toda a cadeia até a
  tela: `toRegisteredSchedule` → `RegisteredSchedule.pool` → `LiveScheduledTask.pool` → uma
  coluna **Pool** na tabela de Live Schedules (`—` quando a agenda não é pinada).
  
  O caso que motivou isso é o `@adonis-agora/durable`: uma `static schedule` descoberta por
  TODOS os `durable:work` que carregam o workflow nasce no namespace do pool que ganha a
  corrida do tick. Quando um dos pools não tem a capacidade exigida pelos steps (ex.: o
  worker de chat, sem Chrome), ele pode criar um run que ninguém a serviço — a janela morre
  em `RemoteStepTimeout` ou erro de binário ausente, e o console não tinha como mostrar
  "esta agenda pertence ao pool X". O durable preenche `pool` a partir do `namespace` pinado
  da agenda, então a tela passa a revelar, numa linha, para qual pool aquela agenda manda
  seus runs.
  
  Campo aditivo e opcional: quem chama `registerSchedule(...)` sem `pool` (todos os callsites
  existentes) normaliza para `null` e renderiza `—`, sem quebrar quem já registrava agendas.

## 1.3.1

### Patch Changes

- [#59](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/59) [`42d4d02`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/42d4d0210ff869d54d264be87cf66722e8645aa0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Some o item "Extensions" da barra lateral; cada dashboard contribuído aparece pelo nome.
  
  A barra tinha **dois** itens levando à mesma tela: "Extensions" (a seção sem dashboard
  escolhido) e, logo abaixo, o dashboard pelo próprio nome — "Workflows", no caso do
  `@adonis-agora/durable`. Um nomeado pelo que a pessoa quer ver, outro pela mecânica que
  entrega.
  
  "Extensão" é um conceito de quem escreve a lib, não de quem lê o console. Os dashboards
  agora entram direto na lista, que é a mesma forma um-item-por-dashboard que o console
  irmão em NestJS usa.
  
  Deep links para `#/extensions` continuam funcionando.

## 1.3.0

### Minor Changes

- [#54](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/54) [`e64e5a6`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/e64e5a633e1939fec630d0209d9e4e12728e78f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O console para de se medir, os painéis param de afirmar saúde que não mediram, e o
  Overview vira página de containers.
  
  **O console não se mede.** A lista "Slowest" em produção vinha com duas rotas do próprio
  telescope no top 5 (`/telescope/api/metrics/timeseries` 3.00s, `/telescope/api/metrics/pulse`
  2.90s). Os endpoints de agregação estão entre os mais lentos que o processo serve — é
  literalmente o trabalho deles — e abrir o Overview gravava mais duas requests lentas no
  ranking e no p99 **do app**. O middleware agora pula o prefixo do dashboard;
  `recordOwnRequests: true` traz o comportamento antigo. O casamento de prefixo é consciente
  de fronteira, para não engolir uma rota `/telescopes` do app.
  
  **Painel que não está medindo para de dizer que está tudo bem.** "No N+1 loops detected." e
  "o watcher `query` está desligado" são afirmações opostas, e o console fazia a primeira
  quando a segunda era verdade — relatando a própria cegueira na voz de boa notícia. O
  `/meta` agora carrega os watchers que estão rodando, e o painel diz qual falta e onde
  ligar. O hook é de três valores: um servidor que não informa não vira uma segunda
  afirmação errada.
  
  **Throughput para de carregar as entries.** O gráfico precisa de `createdAt` e `type`, mas
  só havia `list()`, que faz `select('*')` — sessenta barras custavam cada entry da janela
  com seu blob de `content`. Novo `countByBucket` (opcional) no contrato de store.
  
  **Overview vira página de containers.** Cada painel busca o próprio dado e tem o próprio
  loading e erro, em vez de um `AsyncBlock` sobre o `pulse` travando a grade inteira. Entra
  `@tanstack/react-query` — o que os outros dashboards do ecossistema já usam — porque sem
  dedup dividir a página em containers multiplicaria as requests em vez de paralelizar.
  
  **Os tiles do Overview navegam.** `Slow routes: 4` dizia o problema e escondia a evidência.

## 1.2.0

### Minor Changes

- [#52](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/52) [`1deda85`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/1deda8525ad3b52f652210d268f09f53c66963de) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Performance da lista de traces, paginação server-side, e a tela de Screens.
  
  **Traces deixa de varrer a tabela.** `getTraces` chamava `collect({})` — sem janela,
  sem filtro — carregava até `scanCap` (50.000) entries com o JSON de `content` inteiro,
  agrupava por `traceId` em memória e devolvia 50. Pior que lento: numa tabela dominada
  pelo watcher mais tagarela, o orçamento de 50k acabava antes de chegar nos traces
  interessantes, então a tela era lenta E incompleta. Agora o store escolhe a página de
  trace ids primeiro (`GROUP BY trace_id ORDER BY MAX(created_at)`, indexável) e só então
  buscamos as entries desses traces. `TelescopeStore.listTraceIds` é **opcional**: store de
  terceiro que não implemente cai no caminho antigo, correto e mais lento.
  
  **Filtros no watcher de redis.** Ele gravava TODO comando. Em produção isso deu 211
  entries/minuto (495k linhas, 93% da tabela), quase tudo bookkeeping do próprio
  `@adonisjs/limiter`. Novos `redis.ignoreCommands` / `ignoreKeys` / `ignoreConnections` /
  `sampleRate`. Nada é filtrado por default — o que é ruído é decisão do app — mas o novo
  `floodWarnPerMinute` (600) avisa uma vez nomeando o comando e o prefixo de chave mais
  barulhentos, já no formato de colar na config.
  
  **Aviso quando o watcher de `query` está mudo.** O Lucid só emite `db:query` numa conexão
  com `debug` ligado, e a forma comum é `debug: app.inDev` — o watcher funciona em
  desenvolvimento e grava nada em produção, em silêncio. O boot agora diz isso.
  
  **Screens.** O request watcher classifica cada request em `page` / `api` / `asset`
  (`content.kind` + tag `kind:*`), e o novo `GET /metrics/screens` agrega tráfego por rota.
  A lista de Entries não conseguia responder "quais telas são mais usadas": a visita e os
  XHRs que ela dispara eram todos `request` com uma url.
  
  **Paginação.** `/entries` e `/metrics/traces` aceitam `page=` e respondem `hasMore` (uma
  linha além da página, não um `COUNT` sobre a tabela que a paginação existe para parar de
  varrer). `EntryQuery` ganha `offset` e `traceIds`. Na UI, as tabelas passam a usar
  TanStack Table com `manualPagination`.
  
  **Grupos de exceção deixam de ser limitados a 8.** `topExceptions` é parâmetro do endpoint
  de stats; a tela dedicada pede 200. Um teto de 8 num painel de exceções não escondia a 9ª
  exceção mais comum — tornava ela inalcançável.
  
  **Novo hook `schedules()` no contrato de extensão.** Uma extensão que é dona de um
  scheduler (o `@adonis-agora/durable`, por exemplo) contribui os schedules que já conhece,
  em vez de o app repetir a lista à mão e ela divergir dos decorators.

## 1.1.5

### Patch Changes

- [#50](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/50) [`56d498d`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/56d498d0998c51650172985dcdfe00562290aa5d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two things the dashboard couldn't tell you about a browser-reported error: **who** it happened
  to, and **where to click** to see it.
  
  **`client_exception` is now attributed to the session user.** The ingestor took `user` from the
  request body alone, and no front-end reporter ships the logged-in user by default — so in
  practice every browser error recorded `user: null` and the dashboard's User column sat empty on
  a fully authenticated session. It now reads the `@adonis-agora/context` `userRef()`, resolved
  server-side on that same request (the endpoint sits behind the host's normal middleware stack).
  
  The precedence is a trust decision, not a preference: the endpoint is **public**, so anything in
  the body is a claim a caller could forge for someone else's id. The server-derived context wins
  whenever both are present. The body claim is still honoured when the context has nothing — an
  anonymous page, or a host without `@adonis-agora/context` — because a self-reported id beats no
  attribution when there is nothing to contradict it.
  
  **Exception groups carry their entry type.** `ExceptionGroupStats` and `PulseExceptionGroup` gain
  a `type` (`exception` or `client_exception`), and the dashboard's Exceptions rows deep-link into
  the entries list filtered by *that row's* type. The link used to hard-code `exception`, so every
  click on a browser error landed on a list that by construction could not contain it — "0 shown"
  on a row that had just reported 26 occurrences.
  
  A group spans one type in practice, since grouping is by `familyHash` and a server throw's hash
  never collides with a browser report's; when two entries of different types do share a key, the
  group takes the type of the first seen in the window.

## 1.1.4

### Patch Changes

- [#42](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/42) [`2ff9a9e`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/2ff9a9e4e7ba9ab68f9a14cfb5520587bc75c774) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: a refused page navigation now gets a real page instead of `{"error":"Forbidden"}`.
  
  Opening the `@adonis-agora/telescope-ui` console without permission used to answer the browser
  with the same JSON the API gets. It now serves a built-in access-denied page in the console's
  own visual language — the status, a sentence explaining the refusal, a "Back to app" link and,
  when `dashboardAuth` is configured, a "Sign in" button. Statuses are unchanged (a `401` still
  carries `WWW-Authenticate`, so the built-in `basic` credentials keep prompting natively), API
  requests are unchanged, and an `authorize` hook that redirects still wins.
  
  The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
  `<style>` takes `@adonisjs/shield`'s request nonce when one exists.
  
  New `accessDenied` option on `config/telescope_ui.ts` to customise it — an object (`brand`,
  `title`, `message`, `homeHref`, `loginHref`, `accent`, labels) to tweak the built-in page, or a
  function `(info, ctx) => html | void` to render it yourself or redirect. Core exports the new
  `enforcePageGuard` + `renderAccessDeniedPage` for hosts serving the SPA themselves;
  `@adonis-agora/telescope-ui` now needs `@adonis-agora/telescope >= 0.11.0` for it.
  
  Also: the built-in `dashboardAuth` login page no longer dies under a nonce'd CSP. It is now a real
  HTML form that works without JavaScript — a form submit is answered with a redirect (to the page
  the operator came from, or back to the form with the error shown) while the page's own `fetch`
  keeps getting JSON — and its inline script/style carry `@adonisjs/shield`'s request nonce.
  `renderLoginPage` takes an optional `{ nonce, error, returnTo }`. And the SPA's `401` page sends
  the `WWW-Authenticate: Basic` challenge only when `credentials.basic` is configured
  (`PageGuardOptions.challenge`), so hosts gating on their own `authorize` no longer get a native
  browser prompt over it.

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
