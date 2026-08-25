# User-aware traces, durable screen, hash routing, exception-content overflow — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `@adonis-agora/telescope` dashboard (as deployed at `entretextosassessoria.com.br/telescope`) Aviary-like: traces/entries say who the user is, the durable "Workflows" screen is wired, exception content no longer overflows the viewport, and navigation uses hash deep-links.

**Architecture:** Three parallel surfaces. (1) **Core** (`packages/core`): the request watcher captures `ctx.auth.user` (id + email) into request entries, and the list/trace projections expose it. (2) **UI** (`packages/ui`): shows the user in EntryDetail/TraceDetail/list columns, hardens horizontal-overflow containment, and replaces `useState`-section switching with a dependency-light `useHashRoute`. (3) **App** (entre-textos): wires the already-shipped `durableTelescopeExtension()` and bumps the two telescope deps. Released through the lib's own CI (changesets/action), then the app is bumped here.

**Tech Stack:** TypeScript, AdonisJS 7 (core), React 19 + Tailwind + Base UI (ui), vitest, vite, changesets, pnpm, GitHub Actions (release.yml).

**Repos involved:**
- Lib: `~/personal/adonis-agora-telescope` (master — what's deployed). Work happens here.
- App: this workspace `apps/entre-textos`.

**Safety rules (from app plans/001):** never read/write `.env`; never run migrations; the app's `main` auto-deploys on push → **commit on a branch, do not push the app**. The lib repo is a normal repo (PR → CI → release workflow).

**Baseline commands (run from `~/personal/adonis-agora-telescope`):**
```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```
App: `pnpm exec tsc --noEmit` (from workspace root).

---

## Phase 0 — Baseline

### Task 1: Establish the lib baseline

**Files:** none.

**Step 1:** Run the gates.
Run (in `~/personal/adonis-agora-telescope`):
```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```
Expected: all green. Record the test totals — the rest of the plan must keep them ≥ baseline.

**Step 2:** Commit (only if a failure forced a fix; otherwise skip).
```bash
git -C ~/personal/adonis-agora-telescope status --short
```

---

## Phase 1 — Core: capture the user on request entries

### Task 2: `RequestEntryContent.user` + `resolveRequestUser` + `recordRequest`

**Files:**
- Modify: `packages/core/src/request_watcher.ts`
- Test: `packages/core/test/config_and_middleware.spec.ts`

**Step 1: Write the failing tests**

Add to `test/config_and_middleware.spec.ts` (new `describe('recordRequest user capture')`):

```ts
describe('recordRequest user capture', () => {
  it('records the authenticated user from ctx.auth', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(
      store,
      {
        request: { method: () => 'GET', url: () => '/me' },
        response: { statusCode: 200 },
        auth: { user: { id: 42, email: 'ada@example.com' } },
      } as unknown as HttpContextLike,
      Date.now(),
    );
    const entry = (await store.list())[0];
    expect((entry?.content as { user: unknown }).user).toEqual({
      id: '42',
      email: 'ada@example.com',
    });
  });

  it('records user null when the context has no auth user', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx(), Date.now());
    const entry = (await store.list())[0];
    expect((entry?.content as { user: unknown }).user).toBeNull();
  });

  it('resolves user defensively when auth.user is malformed or throws', async () => {
    const store = new InMemoryTelescopeStore();
    const bogus = {
      request: { method: () => 'GET', url: () => '/' },
      response: { statusCode: 200 },
      auth: { get user() { throw new Error('boom'); } },
    } as unknown as HttpContextLike;
    await recordRequest(store, bogus, Date.now());
    const entry = (await store.list())[0];
    expect((entry?.content as { user: unknown }).user).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @adonis-agora/telescope exec vitest run test/config_and_middleware.spec.ts`
Expected: FAIL — `user` is `undefined` on the content.

**Step 3: Implement**

In `packages/core/src/request_watcher.ts`:

- Extend `RequestEntryContent`:
```ts
  /**
   * The authenticated user at request time, when the host exposes `ctx.auth.user`
   * (Adonis @adonisjs/auth / authkit guard). Only `id` and `email` are captured —
   * never the full model. `null` when unauthenticated or not exposed.
   */
  user: { id: string; email?: string } | null;
```

- Extend `HttpContextLike`:
```ts
  /** The auth guard, when the host registered one (`ctx.auth`). Optional. */
  auth?: { user?: unknown };
```

- Add `RecordRequestOptions`:
```ts
  /**
   * Override the user resolved from `ctx.auth`; pass `null` to force "no user".
   * Omit to resolve from the context (default).
   */
  user?: { id: string; email?: string } | null;
```

- Add the resolver (after `contentLengthOf`):
```ts
/**
 * Read the authenticated user off a (possibly absent) `ctx.auth`, extracting only
 * `id` + `email`. Strictly defensive: any throw or malformed shape yields `null`,
 * so a hostile/odd auth model can never break (or crash) request capture.
 */
export function resolveRequestUser(ctx: HttpContextLike): { id: string; email?: string } | null {
  try {
    const user = ctx.auth?.user;
    if (user === null || user === undefined) return null;
    const record = user as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const email = record.email;
    return {
      id: String(id),
      ...(typeof email === 'string' && email.length > 0 ? { email } : {}),
    };
  } catch {
    return null;
  }
}
```

- In `recordRequest`, resolve + record:
```ts
  const user = options.user === undefined ? resolveRequestUser(ctx) : options.user;
  const input: RecordInput<RequestEntryContent> = {
    type: EntryType.Request,
    content: {
      method,
      url,
      status,
      durationMs,
      traceId: options.traceId ?? null,
      user,
      ...(captureBody !== undefined ? { body: captureBody } : {}),
    },
    ...
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @adonis-agora/telescope exec vitest run test/config_and_middleware.spec.ts`
Expected: PASS (3 new + existing).

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/core/src/request_watcher.ts packages/core/test/config_and_middleware.spec.ts
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope): captura do usuário autenticado em request entries (ctx.auth.user)"
```

### Task 3: Middleware threads the user through

**Files:**
- Modify: `packages/core/src/telescope_middleware.ts`
- Test: `packages/core/test/config_and_middleware.spec.ts`

**Step 1: Write the failing test**

Add inside `describe('TelescopeMiddleware')`:

```ts
  it('records the authenticated user from ctx.auth.user on the request entry', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    const mw = new TelescopeMiddleware();
    await mw.handle(
      {
        request: { method: () => 'GET', url: () => '/me' },
        response: { statusCode: 200 },
        auth: { user: { id: 'u-7', email: 'ada@example.com' } },
      } as never,
      async () => {},
    );
    const entry = (await store.list({ type: 'request' }))[0];
    expect((entry?.content as { user: unknown }).user).toEqual({
      id: 'u-7',
      email: 'ada@example.com',
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @adonis-agora/telescope exec vitest run test/config_and_middleware.spec.ts`
Expected: FAIL — `user` is `null` (middleware doesn't pass it yet).

**Step 3: Implement**

The middleware already hands the real `ctx` to `recordRequest`; `resolveRequestUser` runs inside `recordRequest`, so **no middleware change is needed** for the pass-through — verify the existing `finally` block already calls `recordRequest(store, ctx as unknown as HttpContextLike, startedAt, {...})` (it does). If the test still fails after Task 2, re-check the cast carries `auth`.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @adonis-agora/telescope exec vitest run test/config_and_middleware.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/core/test/config_and_middleware.spec.ts
git -C ~/personal/adonis-agora-telescope commit -m "test(telescope): middleware grava user do ctx.auth.user"
```

### Task 4: `userLabel` in `EntrySummary` and `TraceSummary`

**Files:**
- Modify: `packages/core/src/ui/api.ts`
- Modify: `packages/core/src/metrics/traces.ts`
- Test: `packages/core/test/ui/api.spec.ts`
- Test: `packages/core/test/metrics/timeseries_traces_waterfall.spec.ts`

**Step 1: Write the failing tests**

In `test/ui/api.spec.ts`, after the existing seed/describe, add:

```ts
describe('toSummary user label', () => {
  it('derives userLabel from a request entry content.user (email wins)', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {
        method: 'GET',
        url: '/me',
        status: 200,
        durationMs: 5,
        traceId: 'trace-u',
        user: { id: '42', email: 'ada@example.com' },
      },
      tags: ['method:GET'],
      traceId: 'trace-u',
      durationMs: 5,
      origin: 'http',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = JSON.parse(res.body) as {
      data: { userLabel?: string }[];
    };
    expect(body.data[0]?.userLabel).toBe('ada@example.com');
  });

  it('omits userLabel when content has no user', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'diagnostic',
      content: { lib: 'billing', event: 'invoice-paid' },
      tags: ['lib:billing'],
      origin: 'manual',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = JSON.parse(res.body) as { data: Record<string, unknown>[] };
    expect('userLabel' in (body.data[0] ?? {})).toBe(false);
  });
});
```

In `test/metrics/timeseries_traces_waterfall.spec.ts`, add a test inside `describe('summarizeTraces')`:

```ts
  it('carries the request entry user label onto the trace summary', () => {
    const entries = [
      { ...baseRequest, traceId: 'trace-u', content: { method: 'GET', url: '/me', status: 200, user: { id: '42', email: 'ada@example.com' } } },
      { ...baseQuery, traceId: 'trace-u' },
    ];
    const [summary] = summarizeTraces(entries as never);
    expect(summary?.userLabel).toBe('ada@example.com');
  });
```
(The task shows the real `baseRequest`/`baseQuery` fixtures already in the file — reuse them; `summarizeTraces` takes `Entry[]`, so the fixtures' `createdAt` must be `Date`s as the existing test uses.)

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @adonis-agora/telescope exec vitest run test/ui/api.spec.ts test/metrics/timeseries_traces_waterfall.spec.ts`
Expected: FAIL — `userLabel` is undefined.

**Step 3: Implement**

In `packages/core/src/ui/api.ts`:
- Add to `EntrySummary`:
```ts
  /** The request entry's user (`email` ?? `id`), when the entry carried one. */
  userLabel?: string;
```
- Add a helper + wire into `toSummary`:
```ts
function userLabelOf(entry: Entry): string | undefined {
  const content = entry.content as { user?: unknown } | null | undefined;
  const user = content?.user;
  if (typeof user !== 'object' || user === null) return undefined;
  const record = user as { id?: unknown; email?: unknown };
  if (typeof record.email === 'string' && record.email.length > 0) return record.email;
  return typeof record.id === 'string' ? record.id : undefined;
}
```
and in the returned object add:
```ts
    ...(userLabelOf(entry) !== undefined ? { userLabel: userLabelOf(entry) } : {}),
```

In `packages/core/src/metrics/traces.ts`:
- Add to `TraceSummary`:
```ts
  /** The request entry's user label (`email` ?? `id`), when the trace has one. */
  userLabel?: string;
```
- Add a local extractor mirroring `asRequestLabel`:
```ts
function asRequestUserLabel(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const record = content as { user?: unknown };
  if (typeof record.user !== 'object' || record.user === null) return undefined;
  const user = record.user as { id?: unknown; email?: unknown };
  if (typeof user.email === 'string' && user.email.length > 0) return user.email;
  return typeof user.id === 'string' ? user.id : undefined;
}
```
- Add `userLabel?: string` to `TraceAccumulator`, set it in the same request-entry branch as `rootLabel`, and spread it into the summary (only when defined), matching the `rootLabel` pattern.

**Step 4: Run tests to verify they pass**

Run: the same command as Step 2.
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/core/src/ui/api.ts packages/core/src/metrics/traces.ts packages/core/test/ui/api.spec.ts packages/core/test/metrics/timeseries_traces_waterfall.spec.ts
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope): userLabel nas projeções de entries e traces"
```

---

## Phase 2 — UI: show the user

### Task 5: Mirror `user`/`userLabel` in the client types + fixtures

**Files:**
- Modify: `packages/ui/src/client/types.ts`
- Modify: `packages/ui/src/app/dashboard.spec.tsx`

**Step 1: Update types**

In `packages/ui/src/client/types.ts`:
- `EntrySummary`: add `userLabel?: string;` (mirror core).
- `RequestEntryContent`: add `user: { id: string; email?: string } | null;` (mirror core).

**Step 2: Update fixtures**

In `packages/ui/src/app/dashboard.spec.tsx`:
- `entrySummary` fixture: add `userLabel: 'ada@example.com'`.
- `fullEntry.content`: add `user: { id: '42', email: 'ada@example.com' }`.

**Step 3: Typecheck + test**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run` and `pnpm --filter @adonis-agora/telescope-ui typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/client/types.ts packages/ui/src/app/dashboard.spec.tsx
git -C ~/personal/adonis-agora-telescope commit -m "chore(telescope-ui): types espelham user/userLabel do core"
```

### Task 6: User row in EntryDetail

**Files:**
- Modify: `packages/ui/src/app/EntryDetail.tsx`
- Test: `packages/ui/src/app/dashboard.spec.tsx`

**Step 1: Write the failing test**

In `describe('EntryDetail')` add:

```ts
  it('shows the authenticated user for a request entry', async () => {
    const client = fakeClient();
    renderWith(client, <EntryDetail id="e-1" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
  });
```
(`fullEntry` now carries `content.user`.)

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: FAIL — no `ada@example.com`.

**Step 3: Implement**

Add a helper at module scope in `EntryDetail.tsx`:
```ts
function entryUserLabel(entry: Entry): string | null {
  const content = entry.content as { user?: { id?: string; email?: string } | null } | null;
  const user = content?.user;
  if (!user) return null;
  return user.email ?? user.id ?? null;
}
```
In the Details `<dl>`, after the Trace row add:
```tsx
                <dt className="text-muted-foreground">User</dt>
                <dd className="m-0">{entryUserLabel(entry) ?? '—'}</dd>
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/EntryDetail.tsx packages/ui/src/app/dashboard.spec.tsx
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope-ui): linha User no EntryDetail"
```

### Task 7: User in TraceDetail header

**Files:**
- Modify: `packages/ui/src/app/TraceDetail.tsx`
- Test: `packages/ui/src/app/dashboard.spec.tsx`

**Step 1: Write the failing test**

Add `describe('TraceDetail')`:
```ts
describe('TraceDetail', () => {
  it('shows the request entry user in the trace header', async () => {
    const client = fakeClient({
      entriesByTrace: vi.fn().mockResolvedValue([
        { ...entrySummary, type: 'request', userLabel: 'ada@example.com' },
        { ...entrySummary, id: 'q-1', type: 'query', summary: 'select 1', userLabel: undefined },
      ]),
    });
    renderWith(client, <TraceDetail traceId="trace-abc123" onOpenEntry={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/ada@example\.com/)).toBeTruthy());
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: FAIL.

**Step 3: Implement**

In `TraceDetail.tsx`:
- Lift the trace-entries fetch to the top so the header and the Entries tab share one call:
```tsx
  const entriesState = useTraceEntries(traceId);
  const userLabel = useMemo(() => {
    const list = entriesState.data ?? [];
    const request = list.find((e) => e.type === 'request' && e.userLabel);
    return request?.userLabel ?? null;
  }, [entriesState.data]);
```
- In the header area (under `SectionTitle`), add:
```tsx
      <p className="mb-3 text-xs text-muted-foreground">
        user: <span className="text-foreground">{userLabel ?? '—'}</span>
      </p>
```
- Change `TraceEntries` to receive the already-loaded state instead of fetching:
```tsx
function TraceEntries({
  state,
  onOpenEntry,
}: {
  state: AsyncState<EntrySummary[]>;
  onOpenEntry: (id: string) => void;
}) { ... }
```
remove its `useTraceEntries` line, and call it as `<TraceEntries state={entriesState} onOpenEntry={onOpenEntry} />`.
- Import `useMemo` and `AsyncState`/`EntrySummary` types as needed.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/TraceDetail.tsx packages/ui/src/app/dashboard.spec.tsx
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope-ui): usuário no header do TraceDetail"
```

### Task 8: User columns in Entries + Traces lists

**Files:**
- Modify: `packages/ui/src/app/EntriesSection.tsx`
- Modify: `packages/ui/src/app/TracesSection.tsx`
- Test: `packages/ui/src/app/dashboard.spec.tsx`

**Step 1: Write the failing tests**

In `describe('EntriesSection')` add:
```ts
  it('shows the user column', async () => {
    const client = fakeClient();
    renderWith(client, <EntriesSection onOpenEntry={vi.fn()} onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
  });
```
In `describe('TracesSection')` add:
```ts
  it('shows the user column', async () => {
    const client = fakeClient({ traces: vi.fn().mockResolvedValue([{ ...traceSummary, userLabel: 'ada@example.com' }]) });
    renderWith(client, <TracesSection onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
  });
```

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: FAIL.

**Step 3: Implement**

`EntriesSection.tsx` table header: add `<TableHead>User</TableHead>` after `Summary`; row: add
```tsx
                    <TableCell className="text-muted-foreground">{e.userLabel ?? '—'}</TableCell>
```
after the Summary cell.

`TracesSection.tsx` table header: add `<TableHead>User</TableHead>` after `Trace`; row: add
```tsx
                  <TableCell className="text-muted-foreground">{t.userLabel ?? '—'}</TableCell>
```
after the Trace cell.

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run`
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/EntriesSection.tsx packages/ui/src/app/TracesSection.tsx packages/ui/src/app/dashboard.spec.tsx
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope-ui): coluna User nas listas de entries e traces"
```

---

## Phase 3 — Exception-content overflow

### Task 9: Reproduce the overflow in a real browser

**Files:**
- Create (scratch, NOT committed): `/tmp/telescope-stub/server.mjs`
- Create (scratch): `/tmp/telescope-stub/exception-content.json`

**Step 1: Build the SPA**

Run: `pnpm --filter @adonis-agora/telescope-ui build`
Expected: `packages/ui/dist/spa/` produced.

**Step 2: Write a tiny stub server**

Create `/tmp/telescope-stub/server.mjs`:
- Serves `packages/ui/dist/spa` statically.
- Routes the SPA calls on boot + on opening an exception entry detail:
  - `GET /telescope/api/meta` → `{ data: { entryTypes: [], dashboards: [], ai: { enabled: false } } }`
  - `GET /telescope/api/retention` → `{ data: { ... } }` (any)
  - `GET /telescope/api/entries?limit=100` → a list containing one `exception` summary
  - `GET /telescope/api/entries/exception-1` → an exception entry whose `content` has: a very long single-line stack frame (e.g. a 20 000-char URL), a 50 000-char base64-ish line, and a deeply nested body — the "lots of content" case
  - `GET /telescope/api/metrics/pulse` → empty-ish pulse (so Overview doesn't crash)
  - All other `/telescope/api/*` → `{ data: [] }` / `{ data: {} }` as appropriate
- Serve the SPA so `index.html` is reachable and `./assets/*` resolve.

**Step 3: Reproduce**

- Start the stub: `node /tmp/telescope-stub/server.mjs` (background, pick a port, e.g. 4310).
- Use the browser tool to open `http://localhost:4310/telescope/#/entries/exception-1`.
- Evaluate in the page:
```js
({
  docScrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  overflowing: [...document.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 20)
    .map((el) => el.tagName + '.' + (el.className?.toString().slice(0, 60) ?? '')),
})
```
Expected: `docScrollWidth > innerWidth` and a non-empty `overflowing` list → this confirms and names the exact element(s). **Record the culprit(s) here** (e.g. `SECTION.panel`/`PRE`/`DL`) — the fix in Task 10 targets exactly those.

**Step 4: Do not commit scratch files.**

### Task 10: Fix the overflow + verify

**Files:**
- Modify: `packages/ui/src/app/EntryDetail.tsx`
- Modify: `packages/ui/src/app/ui.tsx` (only if a shared primitive is the culprit)
- Modify: `packages/ui/src/app/index.css` (only if `main`/body needs containment)
- Maybe: `packages/ui/src/app/ExceptionsSection.tsx`

**Step 1: Apply the targeted fix**

Apply containment where the repro pointed, at minimum:
- `EntryDetail.tsx` grid wrapper: change `md:grid-cols-[2fr_1fr]` → `md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` (grid items can no longer force the track wider).
- `CODE_CLASS`: add `max-w-full` so the `pre` never exceeds its container; keep `overflow-x-auto`.
- The Details `<dl>`: ensure the `1fr` column can shrink (`grid-cols-[max-content_minmax(0,1fr)]`).
- `App.tsx` `<main>`: add `overflow-x-hidden`.
- `ExceptionsSection.tsx` message cell: `max-w-0 truncate` (ellipsis) on the Message cell if it was in the culprit list.

**Step 2: Rebuild + re-verify**

Run: `pnpm --filter @adonis-agora/telescope-ui build`, restart the stub, re-open the same URL, re-run the overflow probe from Task 9 Step 3.
Expected: `docScrollWidth <= innerWidth` and `overflowing` empty. Screenshot before/after for the user.

**Step 3: Run the UI test suite + typecheck**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run` and `pnpm --filter @adonis-agora/telescope-ui typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/EntryDetail.tsx packages/ui/src/app/App.tsx packages/ui/src/app/ExceptionsSection.tsx
git -C ~/personal/adonis-agora-telescope commit -m "fix(telescope-ui): contém overflow horizontal do content de exception"
```

---

## Phase 4 — Hash routing

### Task 11: `useHashRoute` hook + parse/format

**Files:**
- Create: `packages/ui/src/app/use-hash-route.ts`
- Create: `packages/ui/src/app/use-hash-route.spec.ts`

**Step 1: Write the failing tests**

Create `use-hash-route.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatHash, parseHash } from './use-hash-route.js';

describe('parseHash', () => {
  it('defaults to overview on empty/unknown hash', () => {
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/bogus')).toEqual(DEFAULT_ROUTE);
  });
  it('parses section routes', () => {
    expect(parseHash('#/overview')).toEqual({ name: 'overview' });
    expect(parseHash('#/traces')).toEqual({ name: 'traces' });
  });
  it('parses entries type query', () => {
    expect(parseHash('#/entries?type=query')).toEqual({ name: 'entries', type: 'query' });
  });
  it('parses deep links', () => {
    expect(parseHash('#/entries/e-1')).toEqual({ name: 'entry', id: 'e-1' });
    expect(parseHash('#/traces/t-1')).toEqual({ name: 'trace', traceId: 't-1' });
    expect(parseHash('#/extensions/durable.workflows')).toEqual({
      name: 'extensions',
      dashboardId: 'durable.workflows',
    });
  });
});

describe('formatHash', () => {
  it('round-trips routes', () => {
    expect(formatHash({ name: 'entry', id: 'e-1' })).toBe('#/entries/e-1');
    expect(formatHash({ name: 'entries', type: 'query' })).toBe('#/entries?type=query');
    expect(formatHash({ name: 'trace', traceId: 't-1' })).toBe('#/traces/t-1');
    expect(formatHash({ name: 'extensions', dashboardId: 'durable.workflows' })).toBe(
      '#/extensions/durable.workflows',
    );
  });
});
```
Also add a hook integration test (jsdom) that renders a probe component, sets `location.hash`, dispatches `hashchange`, and asserts the route updates.

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run use-hash-route.spec.ts`
Expected: FAIL (module missing).

**Step 3: Implement**

Create `packages/ui/src/app/use-hash-route.ts` with the discriminated union `TelescopeRoute`, `DEFAULT_ROUTE`, `parseHash`, `formatHash`, and `useHashRoute` (reads `window.location.hash`, subscribes to `hashchange`, `navigate()` writes the hash). See the design doc for the full grammar. Keep it dependency-free.

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run use-hash-route.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/use-hash-route.ts packages/ui/src/app/use-hash-route.spec.ts
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope-ui): hook useHashRoute com deep links"
```

### Task 12: Rewire `App.tsx` to the route

**Files:**
- Modify: `packages/ui/src/app/App.tsx`

**Step 1: Rewire**

- Replace the `section`/`entryId`/`traceId`/`entryPreset`/`dashboardId` `useState`s with `useHashRoute()`.
- On mount (once), if `window.location.hash === ''`, set it to `#/overview`.
- `go(key)` → `navigate({ name: key })` (SectionKey names already match route names).
- `openEntry(id)` → `navigate({ name: 'entry', id })`.
- `openTrace(traceId)` → `navigate({ name: 'trace', traceId })`.
- `openType(type)` → `navigate({ name: 'entries', type })`.
- Dashboard buttons → `navigate({ name: 'extensions', dashboardId: d.id })`.
- `CommandPalette.navigate` maps `PaletteTarget` kinds to the matching routes.
- Nav active states key off `route.name` (and `route.type` for watchers, `route.dashboardId` for dashboards).
- `main` renders by `route.name`; pass `onBack` handlers that navigate back (`entries` / `traces`).
- EntriesSection `key`: `route.name === 'entries' ? route.type ?? 'default' : undefined`; pass `presetType={route.type}` when set.

**Step 2: Test + typecheck**

Run: `pnpm --filter @adonis-agora/telescope-ui exec vitest run` and `pnpm --filter @adonis-agora/telescope-ui typecheck`
Expected: PASS.

**Step 3: Smoke-verify with the stub**

Rebuild, open `http://localhost:4310/telescope/#/entries?type=query`, then click a watcher in the sidebar and the browser Back button — the hash and view must both change and agree.

**Step 4: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add packages/ui/src/app/App.tsx
git -C ~/personal/adonis-agora-telescope commit -m "feat(telescope-ui): navegação por hash routes com deep links"
```

---

## Phase 5 — Release (lib CI)

### Task 13: Changesets + full gates

**Files:**
- Create: `~/.changeset/2026-08-25-user-durable-hashroutes.md` (in the lib repo)

**Step 1: Write the changeset**

```md
---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": minor
---

feat: request entries capturam o usuário autenticado (ctx.auth.user → id/email) com userLabel nas projeções de entries/traces; UI mostra o usuário em detail/trace/listas, navegação por hash routes com deep links e contenção de overflow horizontal no content de exception
```

**Step 2: Run the full gates**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: green, ≥ baseline.

**Step 3: Commit**

```bash
git -C ~/personal/adonis-agora-telescope add .changeset && git -C ~/personal/adonis-agora-telescope commit -m "chore: changesets pra release (user traces, hash routes, overflow, durable wiring)"
```

### Task 14: Push + PR + release workflow

**Steps:**
1. Create a branch: `git -C ~/personal/adonis-agora-telescope checkout -b feat/user-durable-hashroutes-overflow`
2. Push: `git -C ~/personal/adonis-agora-telescope push -u origin feat/user-durable-hashroutes-overflow`
3. Open PR to master: `gh pr create --base master --title "feat: user traces, hash routes, overflow fix" --body "…"` — wait for `ci.yml` green.
4. Merge the PR (`gh pr merge --squash --delete-branch`).
5. Back on master, trigger the release: `gh workflow run release.yml` → wait for the "chore: version packages" PR → merge it.
6. Run `gh workflow run release.yml` again → publishes both packages (OIDC trusted publishing).
7. Confirm on npm: `npm view @adonis-agora/telescope version` and `npm view @adonis-agora/telescope-ui version` — note both exact versions for Task 15.

---

## Phase 6 — App wiring (this workspace)

### Task 15: Bump telescope deps + wire durable extension

**Files:**
- Modify: `apps/entre-textos/package.json`
- Modify: `apps/entre-textos/config/telescope.ts`

**Step 1: Bump deps**

In `apps/entre-textos/package.json`, set `@adonis-agora/telescope` and `@adonis-agora/telescope-ui` to the exact versions from Task 14 step 7 (replacing `0.8.5` / `1.0.3`).

**Step 2: Wire the durable extension**

In `apps/entre-textos/config/telescope.ts`:
```ts
import { durableTelescopeExtension } from '@adonis-agora/durable/telescope'
```
and add to the config object:
```ts
  extensions: [durableTelescopeExtension()],
```

**Step 3: Install + gates**

Run: `pnpm install` then `pnpm exec tsc --noEmit` (workspace root).
Expected: 0 errors. If `tsc --noEmit` is green but a narrower check exists for entre-textos, run it too.

**Step 4: Commit on a branch (no push)**

```bash
git add apps/entre-textos/package.json apps/entre-textos/config/telescope.ts pnpm-lock.yaml
git checkout -b feat/telescope-durable-user-bump
git commit -m "feat(entre-textos): liga durableTelescopeExtension e bumpa @adonis-agora/telescope*"
```

---

## Done criteria

- [ ] Baseline reported before edits (Task 1).
- [ ] Core: request entries carry `content.user` (id+email) from `ctx.auth.user`; `EntrySummary`/`TraceSummary` expose `userLabel`; unit tests prove all three.
- [ ] UI: User shown in EntryDetail, TraceDetail header, Entries + Traces columns (component tests).
- [ ] Overflow: reproduced in a browser, fixed, and re-verified (`scrollWidth <= innerWidth`).
- [ ] Hash routing: `useHashRoute` with parse/format unit tests; App navigates exclusively via hash; back/forward + deep links verified.
- [ ] Lib CI: changesets pushed, version PR merged, both packages published to npm.
- [ ] App: deps bumped to the published versions, durable extension wired, `tsc` 0 errors, committed on a branch (NOT pushed).
- [ ] No `.env` read; no migration run; app `main` untouched (no push).