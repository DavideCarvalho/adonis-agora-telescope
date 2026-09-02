# @adonis-agora/telescope

## 0.14.0

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

## 0.13.0

### Minor Changes

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

- [#48](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/48) [`829f91a`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/829f91a25e1e92370a0aa69795ad9d2195433ce7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `requestEnrichment` hook: attach what only your app knows to every `request` entry.
  
  ```ts
  // config/telescope.ts
  requestEnrichment: (ctx) => {
    const screen = ctx.request.header('x-screen')
    return typeof screen === 'string' ? { tags: [`screen:${screen}`] } : undefined
  }
  ```
  
  The motivating case is one the dashboard could not answer: **which requests came from
  which front-end screen?** Telescope sees `GET /api/v1/researcher/projects` and has no idea
  whether the writing page or the dashboard asked for it. The browser knows; it just had no
  way to say so. Now it sends its current page in a header, the host turns that into a
  `screen:<name>` tag, and the existing tag filter does the rest — no new UI, no new query
  API.
  
  Three optional fields on the returned object:
  
  - **`tags`** — appended to the derived ones. Tags are how the dashboard filters, so this is
    where anything you want to slice by belongs. Capped at 16 tags of 128 characters
    (`MAX_ENRICHMENT_TAGS` / `MAX_ENRICHMENT_TAG_LENGTH`, both exported); blanks and
    non-strings are dropped.
  - **`context`** — free-form fields under `content.context`, for detail you want to read but
    not filter by. Declared before `body` in the content so the recorder's byte budget, which
    drops keys in insertion order, cannot let a captured megabyte-sized body starve out a few
    short context fields.
  - **`user`** — for hosts where neither `ctx.auth.user` nor the `@adonis-agora/context`
    `userRef()` applies. Wins over both; an explicit `options.user` on `recordRequest` still
    wins over it.
  
  The hook is **synchronous** on purpose. It runs on the recording path of every request, so
  an `await` here — a DB lookup for the user, say — would put host I/O between the response
  and the next request. Read what is already on the `ctx`.
  
  A bad hook cannot cost you the entry: a throw, a `null`, a string, an array, a thousand
  tags, a non-object `context` — every one of them degrades to recording exactly what would
  have been recorded without the hook.
  
  Additive: no config change required and behavior is unchanged when `requestEnrichment` is
  unset. Also exports the `RequestEnrichment` / `RequestEnrichmentResult` types.

## 0.12.0

### Minor Changes

- [#46](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/46) [`4fff643`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/4fff643c921969d9f3459d58d7b4409a139350e2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Three things the dashboard was quietly getting wrong: response status, user attribution, and
  whether a browser error counts as an error.
  
  **Response status was `null` on every AdonisJS request.** The watcher read
  `ctx.response.statusCode`, but an Adonis `Response` has no such property — its status lives
  behind `getStatus()` (the `statusCode` it wraps belongs to the Node `ServerResponse`, one level
  down). So every `request` entry recorded `status: null`, no `status:<code>` tag was ever emitted,
  and the pulse **error rate — computed from the 4xx/5xx breakdown — sat at 0% no matter how many
  requests were failing**. The optional `statusCode?: number` on `ResponseLike` could not catch it:
  any object satisfies it. `ResponseLike` now declares both accessors and the watcher prefers
  `getStatus()`, falling back to `statusCode` for Node/Express-style hosts (and a throwing accessor
  degrades to `null` instead of losing the entry).
  
  **User attribution now works with asynchronous auth guards.** `ctx.auth.user` is the
  `@adonisjs/auth` convention: a *synchronous* property. A guard that only resolves through
  `await getUser()` has nothing there at record time, so those stacks recorded `user: null` for
  fully authenticated sessions — the User column and every `user:<id>` tag were dead. The watcher
  now falls back to `userRef()` from the `@adonis-agora/context` accessor, which such hosts already
  publish per request. The guard still wins when it exposes a user; the fallback costs one property
  read and is skipped entirely when `@adonis-agora/context` is absent.
  
  **`client_exception` counts as an exception in metrics.** The alert poller has always read both
  `exception` and `client_exception`, but the metrics side hard-coded the server type — so a
  front-end-only incident paged on Slack/Discord while the overview it linked to rendered
  "Error rate 0.0% · No exceptions recorded 🎉". `summarizePulse` now classifies both,
  `summarizeStats` computes exception groups for both, and `MetricsService.getStats` collects both
  when asked for either (one `list` per type, mirroring the poller, since `EntryQuery.type` is a
  single value). The dashboard's Exceptions section starts showing browser errors with no UI change.
  
  The shared definition now lives in one place — new `EXCEPTION_ENTRY_TYPES` and `isExceptionType`
  exports — because that list living in two places is exactly how the two sides drifted apart. Also
  exports `currentUserRef` and the `UserRef` type alongside the existing `currentTraceId`.

## 0.11.0

### Minor Changes

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

## 0.10.0

### Minor Changes

- [#38](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/38) [`2c15898`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/2c1589856f0e58afd3bd4d33ab6a266fcf938bb6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Remove `renderDashboard` from `@adonis-agora/telescope/ui`, and the `dashboard.html` it served.
  
  It was the console before `@adonis-agora/telescope-ui` existed: one self-contained page whose whole
  UI was an inline `<script>`. Nothing has routed it since the React console replaced it, and it
  could not have worked under the CSP a shield-hardened host runs (`script-src 'self' 'nonce-…'`
  drops that script whole, leaving a blank page). The docs no longer offer it as a "build your own
  UI" option either — that path is the JSON API, which is what the console itself consumes. The
  `fillLinkHref` / `tablePagination` helpers it mirrored stay exported.

## 0.9.1

### Patch Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/34) [`7565d6e`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7565d6eb5227ce039d8af2abd7e81011b1cc145f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: request entries agora carregam tag `user:<id>` (Pulse load-by-user); UI: botão Back in-app preserva contexto via history (fallback pra seção) + teste App-level de navegação por hash

## 0.9.0

### Minor Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/32) [`91e701a`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/91e701ab8f22f7546d0a41416de24debfb2dffaf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: request entries capturam o usuário autenticado (`ctx.auth.user` → `id`/`email`, defensivo) com `userLabel` nas projeções de entries/traces; UI mostra o usuário em detail/trace/listas, navegação por hash routes com deep links (`#/entries/:id`, `#/traces/:id`, `#/entries?type=`, ...) e contenção de overflow horizontal no content de exception

## 0.8.5

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/30) [`ede467a`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/ede467ac92daa97b829129751f01a41bea759329) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add TanStack Intent AI-agent skills. Ship six SKILL.md guides inside both published
  packages (`packages/*/skills/**`, now included in the `files` array): five core
  skills for `@adonis-agora/telescope` (setup, watchers, storage/retention,
  alerts/AI/client-errors, dashboard access control + MCP) and one for
  `@adonis-agora/telescope-ui` (the React console + `/client`). Adds
  `_artifacts/` domain map, skill spec and skill tree at the repo root, a
  `tanstack-intent` keyword and `@tanstack/intent` devDependency to both packages,
  and an `.github/workflows/check-skills.yml` CI validation workflow.

## 0.8.4

### Patch Changes

- Fix the published package missing `dist/stubs/main.js`.

  `configure.ts` imports `{ stubsRoot } from './stubs/main.js'`, but the build ran
  `copy:stubs` _after_ `tsc` and the script did `rm -rf dist/stubs && cp -R stubs/. dist/stubs/`
  — wiping the freshly compiled `dist/stubs/main.js` and leaving only the raw
  `stubs/main.ts` behind. Every published version so far has therefore failed at
  `node ace configure` with `ERR_MODULE_NOT_FOUND` for `./stubs/main.js`.

  `copy:stubs` now only copies the stub templates (`config/`, `database/`) into
  `dist/stubs/` instead of deleting and replacing the whole directory, so the
  compiled `main.js` survives and ships in the tarball.

## 0.8.3

### Patch Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/28) [`4b6e205`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/4b6e205c87367b48c9817ca1c8e8e2b5258d51c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the commented-out examples in the published config stubs actually compile.

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

## 0.8.2

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

## 0.8.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish a Node.js engine RANGE instead of one exact version. Both packages declared
  `engines.node: "v26.7.0"` — a single pinned build, written by a renovate "pin dependencies" run
  that treated a compatibility range as a version to pin. Every install
  on any other Node emitted an engine warning, and an `engine-strict` install failed outright. Both
  now declare `>=20.6.0`, the version the code actually requires, and renovate is configured to
  leave `engines` alone so the fix survives the next cycle.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the `logs` watcher safe to enable from both config files.

  `watchers: ['logs']` can be set in `config/telescope.ts` (where it also accepts a `logs`
  options block) and in `config/telescope_watchers.ts`. With both set, the second watcher to
  boot silently did nothing — and then unteed the FIRST watcher's tap on shutdown, so the
  logger was left half-instrumented. It now detects that the logger is already tapped, warns
  once naming both config keys, and stays fully inert: it records nothing and its `stop()`
  restores only what it teed itself.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Report the real package version over MCP. The `initialize` handshake advertised a hardcoded
  `0.4.0` regardless of the installed version; it now reads the package's own `VERSION`, which
  the release pipeline keeps in lockstep with `package.json`.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restore the seven `config/*.stub` files, which shipped empty.

  Every config stub the package publishes — `telescope.stub`, `telescope_watchers.stub`,
  `telescope_ui.stub`, `telescope_ai.stub`, `telescope_alerts.stub`, `telescope_mcp.stub` and
  `telescope_cpu_profiling.stub` — was a zero-byte file in the published tarball, so
  `node ace add @adonis-agora/telescope` wrote an EMPTY `config/telescope.ts` (and an empty file
  for each feature you selected) into your app. Only the migration stub had content.

  The stubs are rebuilt from the current config surface, including everything that landed since
  they were lost: the `logs` watcher and its `logs` block, `diagnostics.exclude` /
  `diagnostics.recordClaimed`, `requestCapture`, `redact.perType`, `sampling`, `nPlusOne`, `pulse`,
  `clientErrors`, `dashboardAuth`, `cpuProfiling.armEnabled`, `queueActions`, `queueManager`, the
  `every-exception` and `metric-threshold` alert rules, `alerts.geoLookup`, and the whole
  `telescope_cpu_profiling` config. A test now fails the build if any shipped stub is empty, lacks
  its `exports(...)` header, or carries a backtick in its body — the defect that emptied them.

## 0.8.0

### Minor Changes

- [`13bc033`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/13bc033fb8bcac304e949a90716a6210677bb94d) - feat: watcher `logs` no config — tee do logger do Adonis (níveis info/warn/error/...) gravados como entries `log`, com `logs: { minLevel, tags }` opcional

## 0.7.1

### Patch Changes

- [`b3c7ef0`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/b3c7ef05e06d24175d0926a00961c8652e379417) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `enforceGuard` now honors a redirect a custom `authorize` hook already wrote to the response (a `location` header, typically via `ctx.response.redirect(...)`) instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, which already does this. Lets a host show its own branded "log in" / "access denied" page instead of raw JSON, without needing a separate config hook: redirect from inside `authorize`, return `false`, done.

  `UiResponse` (the framework-light response contract `guard.ts` and the JSON API handlers share) gained `getHeader(name)` to make the check possible; `RecordingResponse` (the in-memory test double) implements it too.

## 0.7.0

### Minor Changes

- [`8d227de`](https://github.com/DavideCarvalho/adonis-telescope/commit/8d227de32147fe58e84dd9d14d2e0cf16eebb56c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: wire AI exception diagnosis into the dashboard API + expose retention/sampling posture

  - **AI exception diagnosis**: a new `POST <path>/api/exceptions/:id/diagnose` route (optional `?force=true` to bypass the cache) re-diagnoses (or serves the cached diagnosis for) an `exception`/`client_exception` entry via the existing `DiagnosisCoordinator`. Degrades to a clear "not configured" response when `@adonis-agora/telescope/ai` isn't installed/configured — the coordinator itself was already published in 0.5.0, this just exposes it through the UI API for the first time.
  - **Retention indicator**: a new `GET <path>/api/retention` route echoes the resolved pruner cutoff (age / optional keep-last floor / cycle interval) and which entry types are being tail-sampled below 100%, so the dashboard can show a static "what's being kept" summary. No live pruner run-history — that stays a per-process runtime handle (`TelescopePruner.getRuns()`) for hosts that want it directly.
  - `GET <path>/api/meta` now always registers (previously gated behind an extension registry booting) and reports `ai.enabled` / `profiling.enabled` / `queueManager.enabled` flags alongside any extension-contributed `entryTypes`/`dashboards`.

  Both routes are additive and read-only; no existing route or response shape changed.

- [`8d227de`](https://github.com/DavideCarvalho/adonis-telescope/commit/8d227de32147fe58e84dd9d14d2e0cf16eebb56c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: Live Queue Manager, Live Schedules, and CPU flamegraph profiling — three new opt-in backend capabilities

  - **Live Queue Manager** (`queue-manager` watcher, `src/watchers/queue_manager.ts`): a live list/inspect/retry/enqueue control surface over `@adonisjs/queue` (`@boringnode/queue`'s engine), distinct from the existing `queue` watcher which only records past job executions. Built strictly against `@boringnode/queue`'s real, verified public API (`getJob`/`retryJob`/`sizeOf`) — advertised via a `capabilities` getter rather than faking operations the engine doesn't support (no `remove`/`promote`). Requires explicit `queueManager.queues` in `config/telescope_watchers.ts` (the engine has no queue-enumeration API to auto-discover from) and degrades to `configured: false` when `@adonisjs/queue` isn't installed. New `GET <path>/api/queues/live`, `GET <path>/api/queues/live/:queue/jobs/:id`, and mutation routes `POST .../jobs/:id/retry` / `POST .../enqueue` (both behind a default-deny `telescope_ui.queueActions.enabled` gate, on top of the existing read guard).
  - **Live Schedules**: a new `registerSchedule()` / `unregisterSchedule()` / `listRegisteredSchedules()` API on `ScheduleWatcher` (exported from `@adonis-agora/telescope/watchers`) — an explicit, idempotent registry of "this scheduled task exists," since AdonisJS has no first-party scheduler registry to read the way `@nestjs/schedule`'s `SchedulerRegistry` can be scanned. `nextRunAt` is computed from the registered cron expression via the new OPTIONAL `cron-parser` peer (`peerDependenciesMeta` marks it `optional: true`, mirroring this repo's existing graceful-no-op convention); it's `null` — an honest "unknown," never a guess — for non-cron kinds or when the peer is absent. New `GET <path>/api/schedules/live` route joins registrations with their most recent recorded run.
  - **CPU flamegraph profiling** (`@adonis-agora/telescope/cpu_profiling`, new optional sub-entry point + `telescope_cpu_profiling_provider`): a `node:inspector`-based V8 CPU profiler, ported near-verbatim from the NestJS sibling. Opt-in per-request capture via `TelescopeMiddleware` (gated by `ProfilerService.shouldProfile`, a single cheap boolean check when the feature isn't installed), aggregated into a flamegraph tree + precomputed hot frames and recorded as a new `cpu_profile` entry type. New `GET <path>/api/profiles/status`, `GET <path>/api/profiles`, `GET <path>/api/profiles/:id`, and a manual-arm `POST <path>/api/profiles/arm` (behind a default-deny `telescope_ui.cpuProfiling.armEnabled` gate — it's real CPU overhead).

  All three are pure additive capabilities: unconfigured/uninstalled, every touchpoint degrades to inert (no overhead, 404/"not configured" responses) — no existing behavior changes.

## 0.6.0

### Minor Changes

- Parity sync from nestjs-telescope (redact binary-blob bound, client-error reorder, Slack section spread, diagnostics exclude/recordClaimed, exception alert enrichment + every-exception + isNew badge, lib:event span labels, client_exception polling, perType redaction budgets, paged ext-dashboard + trace deep-links, requestCapture gates).

## 0.5.0

### Minor Changes

- Entry pruner, event-loop overload guard, client-error ingestion; Pulse health rollup; alerter pipeline; outgoing HTTP-client watcher; MCP server endpoint; AI diagnosis coordinator; Lucid query watcher; observability UI dashboard (@adonis-agora/telescope-ui); dashboard session auth (login screen); profiling + schedule watchers.

### Patch Changes

- Export the `configure` hook from the package root so `node ace configure @adonis-agora/telescope` resolves it, and de-backtick the config stub comments that broke the tempura stub renderer.

## 0.3.3

### Patch Changes

- fix: sync VERSION across sub-entry barrels (ui/watchers/ai/alerts) and make sync-version.mjs walk every .ts under src/ so --check guards the nested literals against re-drift

## 0.3.2

### Patch Changes

- [`42c5ec9`](https://github.com/DavideCarvalho/adonis-telescope/commit/42c5ec940b02e9ffae0473c2aec7d358388e34ab) - fix: sync VERSION literal via sync-version guard

## 0.3.1

### Patch Changes

- [`67af460`](https://github.com/DavideCarvalho/adonis-telescope/commit/67af460cae249dfb852fa23c7e7b3b46715fdc88) - fix: request-replay targets the live request port (default 3333, not 3000)

## 0.3.0

### Minor Changes

- [`50cb0a6`](https://github.com/DavideCarvalho/adonis-telescope/commit/50cb0a67689f6c381b4b85ea5333ffc97b5a00bd) - Add three per-technology watchers, ports of the NestJS originals:

  - **queue** — records `@adonisjs/queue` job executions (queue, job name, payload, status, attempts, duration) by subscribing to the engine's (`@boringnode/queue`) `node:diagnostics_channel` execution trace. Optional peer: a pure no-op when nothing publishes (peer absent).
  - **events** — records every event emitted through the core `@adonisjs/core` Emitter via `emitter.onAny(...)` (name + payload), with a configurable ignore-list (`db:query` / `mail:sent` excluded by default to avoid double-recording the query/mail watchers).
  - **redis** — records `@adonisjs/redis` commands (command, args, connection, duration) by wrapping the underlying ioredis `sendCommand` on each connection (current and future, via the manager's `connection` event). Optional peer: a no-op when the manager is absent.

  All three are registered in `config/telescope_watchers.ts` with a toggle, route entries through the central redacting store, and degrade gracefully when their optional peer is missing.

  The **schedule** watcher was intentionally **skipped**: AdonisJS has no first-party scheduler (unlike `@nestjs/schedule`), and community schedulers expose no event/hook surface to tap without inventing an API. In the Agora ecosystem `@adonis-agora/durable` already bridges scheduled/cron runs onto the diagnostics bus, which the existing diagnostics watcher records — so scheduled-run observability is covered there.

- [`a3a114e`](https://github.com/DavideCarvalho/adonis-telescope/commit/a3a114e314c9fe5acbb8262dfd22b07596f62049) - feat: tail-sampling, N+1 detection, and metrics (stats/timeseries/percentiles/waterfall)

  Three data features ported from the NestJS `nestjs-telescope` originals:

  - **Tail-sampling** — a per-entry-type keep `rate` with optional `keepErrors` / `keepSlowMs` overrides, applied on the WRITE path via a `SamplingTelescopeStore` decorator so dropped entries are never persisted. The decision is a pure function with an injected RNG (deterministic in tests). Configured via `sampling` (a bare rate or per-type rules); default-off (records everything when unset).
  - **N+1 detection** — read-only analysis over stored entries grouped by trace: a flat family-count (`detectNPlusOne`) and a loop-attribution detector (`detectNPlusOnePatterns`) that names the likely driving parent and ranks loops by total wasted duration. Configured via `nPlusOne: { threshold, enabled }` (default threshold 3). Exposed at `GET <path>/api/metrics/n-plus-one/:traceId`.
  - **Metrics** — storage-agnostic aggregations over the store interface: per-type stats with p50/p95/p99 latency percentiles (raw nearest-rank + a histogram estimate that agrees within one bucket-width), per-type breakdowns (query family / cache / request status / exception groups), throughput timeseries, a trace list, and a per-trace span waterfall. Exposed at `GET <path>/api/metrics/stats`, `/api/metrics/timeseries`, `/api/metrics/traces`, and `/api/metrics/waterfall/:traceId`.

- [`e882649`](https://github.com/DavideCarvalho/adonis-telescope/commit/e8826499ff7d1af16d749f2c8b06128b64adadcd) - feat: replay a captured request from the dashboard

- [`4f03836`](https://github.com/DavideCarvalho/adonis-telescope/commit/4f03836bc5b5a5cb119ee4f9097d0c5794a99f55) - feat: SSE live-stream of telescope entries to the dashboard

  Port of the NestJS `sse/` feature. A new in-process entry-events bus (`EntryEvents`) receives every newly-persisted entry from the store's write path — published by an outermost `StreamingTelescopeStore` decorator, so only entries that were actually stored (already redacted, post-sampling — never raw) are streamed. A new `GET <telescope>/api/stream` Server-Sent-Events route (behind the existing UI guard) pushes each entry to the dashboard live as an `entry` frame, with a 15s heartbeat and client-disconnect cleanup.

  Zero-overhead by default: while no dashboard is connected the publish path is a cheap no-op. Toggle with `stream: { enabled: false }` in `config/telescope.ts` (enabled by default).

## 0.2.0

### Minor Changes

- [`b756f29`](https://github.com/DavideCarvalho/adonis-telescope/commit/b756f2995fab618db9e2ba319685099d09c3547c) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22)
