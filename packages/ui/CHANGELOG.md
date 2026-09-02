# @adonis-agora/telescope-ui

## 1.4.0

### Minor Changes

- [#56](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/56) [`44658cf`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/44658cf0783312fef057d8ee6abb46c712e4744e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O console para de se medir, os painéis param de afirmar saúde que não mediram, e o
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
