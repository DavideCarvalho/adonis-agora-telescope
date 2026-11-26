import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TelescopeUiProvider from '../providers/telescope_ui_provider.js';
import { resolveConfig } from '../src/define_config.js';
import { devToolsDecisionOf, devToolsGate } from '../src/dev_tools/telescope_dev_tools.js';
import { scopedTelescopeTools } from '../src/dev_tools/telescope_tools.js';
import { EntryType } from '../src/entry.js';
import {
  resetTelescopeRuntime,
  setTelescopeEntryEvents,
  setTelescopeRuntime,
} from '../src/registry.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { EntryEvents } from '../src/stream/entry_events.js';
import { resolveTenancy } from '../src/tenancy.js';
import { entryInScope, scopedStore, TenantScopedStore } from '../src/tenancy_store.js';
import {
  appOfTag,
  appTag,
  type ConsoleAppScope,
  consoleAppScope,
  describeAppScope,
  KnownAppsCache,
  knownApps,
  selectAppScope,
  viewerStore,
} from '../src/ui/app_scope.js';
import { authorizeByToken } from '../src/ui/console_authorize.js';
import { normalizeConsoleDecision } from '../src/ui/console_decision.js';
import { runGuard } from '../src/ui/guard.js';
import { makeRequest, RecordingResponse } from '../src/ui/http.js';

const TENANCY_SLOT = Symbol.for('@agora/context:tenancy');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[TENANCY_SLOT];
});

/** Two apps' entries (a request, a query in its trace, an exception, a log each) and one untagged. */
async function seeded(extraTags: (app: string) => string[] = () => []) {
  const store = new InMemoryTelescopeStore();
  const ids: { a: string[]; b: string[] } = { a: [], b: [] };
  for (const app of ['a', 'b'] as const) {
    const tags = [appTag(app), ...extraTags(app)];
    const traceId = `trace-${app}`;
    const marker = `secret-${app}`;
    const rows = [
      await store.record({
        type: EntryType.Request,
        content: { method: 'GET', url: `/${marker}`, status: 500, duration: 12 },
        tags,
        traceId,
        durationMs: 12,
      }),
      await store.record({
        type: EntryType.Query,
        content: { sql: `select '${marker}'`, duration: 3 },
        tags,
        traceId,
        durationMs: 3,
      }),
      await store.record({
        type: EntryType.Exception,
        content: { class: 'Boom', message: marker },
        tags,
        traceId,
        familyHash: 'Boom',
      }),
      await store.record({
        type: EntryType.Log,
        content: { level: 'error', message: marker },
        tags,
      }),
    ];
    ids[app] = rows.map((row) => row.id);
  }
  const untagged = await store.record({
    type: EntryType.Log,
    content: { level: 'info', message: 'secret-standalone' },
    tags: [],
  });
  return { store, ids, untagged: untagged.id };
}

describe('app scope', () => {
  it('authorize can grant apps; normalization keeps them next to tenants', async () => {
    expect(normalizeConsoleDecision({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    expect(normalizeConsoleDecision({ allowed: true, apps: ['a', 2], tenants: ['x'] })).toEqual({
      allowed: true,
      apps: ['a', '2'],
      tenants: ['x'],
    });
    // A malformed list narrows to none (fail closed), never to every app.
    expect(normalizeConsoleDecision({ allowed: true, apps: 'nope' })).toEqual({
      allowed: true,
      apps: [],
    });
    const result = await runGuard(
      { request: makeRequest('GET'), response: new RecordingResponse() },
      () => ({ allowed: true, apps: ['a'] }),
    );
    expect(result).toEqual({ allowed: true, apps: ['a'] });
  });

  it('omitted or * → every app; a list → those; ?app= narrows, never widens', () => {
    expect(consoleAppScope({})).toEqual({ all: true });
    expect(consoleAppScope({ apps: '*' })).toEqual({ all: true });
    expect(consoleAppScope({ apps: ['a', 'a'] })).toEqual({ all: false, ids: ['a'] });
    const all = { all: true } as const;
    expect(selectAppScope(all, undefined)).toEqual({
      tags: null,
      restricted: false,
      forged: false,
    });
    expect(selectAppScope(all, '*').tags).toBeNull();
    expect(selectAppScope(all, 'b').tags).toEqual(['app:b']);
    const some: ConsoleAppScope = { all: false, ids: ['a'] };
    expect(selectAppScope(some, undefined)).toEqual({
      tags: ['app:a'],
      restricted: true,
      forged: false,
    });
    expect(selectAppScope(some, 'a').tags).toEqual(['app:a']);
    expect(selectAppScope(some, 'b')).toEqual({ tags: [], restricted: true, forged: true });
    expect(appOfTag('app:x')).toBe('x');
    expect(appOfTag('app:')).toBeUndefined();
    expect(appOfTag('tenant:x')).toBeUndefined();
  });

  it('tenant AND app: a store narrowed by both reads only their intersection', async () => {
    const { store } = await seeded((app) => [app === 'a' ? 'tenant:acme' : 'tenant:globex']);
    await store.record({ type: 'log', content: {}, tags: ['app:b', 'tenant:acme'] });
    const both = scopedStore(store, ['tenant:acme'], ['app:a']);
    expect(both).toBeInstanceOf(TenantScopedStore);
    const rows = await both.list();
    expect(rows).toHaveLength(4);
    expect(rows.every((e) => e.tags.includes('app:a') && e.tags.includes('tenant:acme'))).toBe(
      true,
    );
    expect(await both.list({ size: 2, page: 2 })).toHaveLength(2);
    expect(await both.count()).toBe(4);
    expect(await scopedStore(store, ['tenant:acme'], []).list()).toEqual([]);
    expect(scopedStore(store, null, null)).toBe(store);
    expect(entryInScope({ tags: ['app:a'] }, null, ['app:a'])).toBe(true);
    expect(entryInScope({ tags: ['app:a'] }, ['tenant:x'], ['app:a'])).toBe(false);
  });

  it('describes the picker: known apps for *, the granted ones otherwise, labels from config', async () => {
    const { store } = await seeded();
    const all = await describeAppScope({ all: true }, store, { a: 'App A' });
    expect(all.enabled).toBe(true);
    expect(all.all).toBe(true);
    expect(all.tag).toBe('app');
    expect(all.apps.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'a', label: 'App A' },
      { id: 'b', label: 'b' },
    ]);
    expect(
      await describeAppScope({ all: false, ids: ['b'] }, store, async (ids) =>
        Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
      ),
    ).toEqual({ enabled: true, tag: 'app', all: false, apps: [{ id: 'b', label: 'B' }] });
    // A standalone app: no entry carries an app tag → the picker stays hidden.
    const standalone = new InMemoryTelescopeStore();
    await standalone.record({ type: 'log', content: {}, tags: [] });
    expect(await describeAppScope({ all: true }, standalone)).toEqual({
      enabled: false,
      tag: 'app',
      all: true,
      apps: [],
    });
  });

  it('knownApps reads a bounded recent sample, never the whole table', async () => {
    const store = new InMemoryTelescopeStore();
    const countTags = vi.fn();
    (store as unknown as { countTags: unknown }).countTags = countTags;
    const list = vi.spyOn(store, 'list');
    const now = Date.now();
    for (const [app, n] of [
      ['busy', 3],
      ['quiet', 1],
    ] as const) {
      for (let i = 0; i < n; i++)
        await store.record({ type: 'log', content: {}, tags: [appTag(app)] });
    }
    await store.record({
      type: 'log',
      content: {},
      tags: [appTag('stale')],
      createdAt: new Date(now - 2 * 3_600_000),
    });

    expect(await knownApps(store, { now: () => now + 1 })).toEqual(['busy', 'quiet']);
    expect(countTags).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ size: 1_000, omitContent: true, after: expect.any(Date) }),
    );
  });

  it('knownApps adds the apps only a source knows (by name) and skips a failing source', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({ type: 'log', content: {}, tags: [appTag('b')] });
    const ids = await knownApps(store, {
      sources: [async () => ['z', 'b', 'a', ''], async () => Promise.reject(new Error('down'))],
    });
    expect(ids).toEqual(['b', 'a', 'z']);
  });

  it('KnownAppsCache shares one read per scope within the TTL and forgets failures', async () => {
    let now = 0;
    const cache = new KnownAppsCache(30_000, () => now);
    const load = vi.fn(async () => ['a']);
    const [x, y] = await Promise.all([cache.get('*', load), cache.get('*', load)]);
    expect(x).toEqual(['a']);
    expect(y).toEqual(['a']);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('tenant-1', load);
    expect(load).toHaveBeenCalledTimes(2);
    now = 30_000;
    await cache.get('*', load);
    expect(load).toHaveBeenCalledTimes(3);

    const failing = vi.fn(async (): Promise<string[]> => Promise.reject(new Error('boom')));
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    await expect(cache.get('f', failing)).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('authorizeByToken can grant apps to a token holder', async () => {
    const authorize = authorizeByToken({ token: 's3cret', apps: ['a'] }) as (
      ctx: unknown,
    ) => unknown;
    const ctx = { request: makeRequest('GET', {}, { authorization: 'Bearer s3cret' }) };
    expect(await authorize(ctx)).toEqual({ allowed: true, apps: ['a'] });
  });

  it('viewerStore combines the tenant and app grants', async () => {
    const { store } = await seeded();
    const tenancy = resolveTenancy(undefined);
    expect(viewerStore(store, {}, tenancy)).toBe(store);
    const onlyA = viewerStore(store, { apps: ['a'] }, tenancy);
    expect((await onlyA.list()).every((e) => e.tags.includes('app:a'))).toBe(true);
    expect(await viewerStore(store, { apps: [] }, tenancy).list()).toEqual([]);
  });
});

describe('MCP tools scoped by app', () => {
  it('each caller reads only its apps; the dev tools gate remembers the grant', async () => {
    const { store } = await seeded();
    const toolsFor = scopedTelescopeTools(store, resolveConfig({}));
    const count = async (apps?: '*' | string[]) =>
      (await toolsFor(apps === undefined ? {} : { apps }).listEntries({ limit: 100 })).items.length;
    expect(await count()).toBe(9);
    expect(await count('*')).toBe(9);
    expect(await count(['a'])).toBe(4);
    expect(await count([])).toBe(0);
    const a = toolsFor({ apps: ['a'] });
    expect(a).toBe(toolsFor({ apps: ['a'] }));
    expect(JSON.stringify(await a.listEntries({ limit: 100 }))).not.toContain('secret-b');

    const ctx = { request: makeRequest('POST'), response: new RecordingResponse() };
    await devToolsGate(() => ({ allowed: true, apps: ['b'] }))(ctx);
    expect(devToolsDecisionOf(ctx)).toMatchObject({ apps: ['b'] });
  });
});

// ─────────────────────────── every console route, end to end ───────────────────────────

type Handler = (ctx: unknown) => unknown;
interface Route {
  method: 'GET' | 'POST';
  pattern: string;
  handler: Handler;
}

/** A router that keeps every route the provider registers. */
function fakeRouter(routes: Route[]) {
  const add = (method: Route['method']) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  return { get: add('GET'), post: add('POST') };
}

async function bootConsole(uiConfig: Record<string, unknown>) {
  const routes: Route[] = [];
  const warn = vi.fn();
  const router = fakeRouter(routes);
  const app = {
    inProduction: false,
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'telescope_ui' ? uiConfig : key === 'telescope' ? {} : fallback,
    },
    container: {
      hasBinding: () => false,
      make: async (binding: string) => {
        if (binding === 'logger') return { warn, debug: () => {}, info: () => {} };
        if (binding === 'router') return router;
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  };
  await new TelescopeUiProvider(app as unknown as ApplicationService).boot();
  return { routes, warn };
}

/** Call one route as the viewer named by `x-apps` (`*` or a comma list). */
async function call(route: Route, qs: Record<string, unknown>, params: Record<string, unknown>) {
  const response = new RecordingResponse();
  const request = makeRequest(route.method, qs, { 'x-apps': 'a' });
  const ctx = {
    request: { ...request, body: () => ({}), request: { on: () => {}, socket: {} } },
    response: Object.assign(response, {
      response: { writeHead: () => {}, write: () => true, on: () => {} },
    }),
    params,
  };
  try {
    await route.handler(ctx);
  } catch (error) {
    return { status: 500, body: String(error) };
  }
  return { status: response.statusCode, body: response.body };
}

describe('console routes: a viewer limited to app a never reads app b', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    resetTelescopeRuntime();
    vi.restoreAllMocks();
  });

  const authorize = (ctx: { request: { header(name: string): string | undefined } }) => {
    const header = ctx.request.header('x-apps');
    return header === '*' ? { allowed: true, apps: '*' } : { allowed: true, apps: [header] };
  };

  it('every GET route, with and without ?app=b', async () => {
    const { store, ids } = await seeded();
    setTelescopeRuntime(store, true);
    setTelescopeEntryEvents(new EntryEvents());
    const { routes } = await bootConsole({ authorize });
    const gets = routes.filter((r) => r.method === 'GET' && !r.pattern.endsWith('/stream'));
    expect(gets.length).toBeGreaterThan(15);
    const leaks: string[] = [];
    for (const route of gets) {
      for (const qs of [{}, { app: 'b' }, { app: '*' }, { type: 'request' }]) {
        for (const id of [ids.b[0], ids.b[2]]) {
          const { body } = await call(route, qs, {
            id,
            traceId: 'trace-b',
            ext: 'x',
            provider: 'y',
            queue: 'q',
          });
          // A route may echo the trace id it was asked for (`meta.traceId`); that is not data.
          const text = JSON.stringify(body ?? null).replaceAll('"traceId":"trace-b"', '');
          if (
            text.includes('secret-b') ||
            text.includes('trace-b') ||
            ids.b.some((b) => text.includes(b))
          ) {
            leaks.push(`${route.pattern} ${JSON.stringify(qs)}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);

    // …while the same routes do show app a.
    const entries = routes.find((r) => r.pattern.endsWith('/api/entries'));
    const shown = await call(entries as Route, {}, {});
    expect(JSON.stringify(shown.body)).toContain('secret-a');
    const one = routes.find((r) => r.pattern.endsWith('/api/entries/:id'));
    expect((await call(one as Route, {}, { id: ids.a[0] })).status).toBe(200);
    expect((await call(one as Route, {}, { id: ids.b[0] })).status).toBe(404);
  });

  it('the apps endpoint lists only the granted apps; global actions are refused', async () => {
    const { store } = await seeded();
    setTelescopeRuntime(store, true);
    const { routes } = await bootConsole({ authorize, apps: { labels: { a: 'App A' } } });
    const apps = routes.find((r) => r.pattern.endsWith('/api/apps')) as Route;
    expect((await call(apps, {}, {})).body).toEqual({
      data: { enabled: true, tag: 'app', all: false, apps: [{ id: 'a', label: 'App A' }] },
    });
    const arm = routes.find((r) => r.pattern.endsWith('/profiles/arm')) as Route;
    const refused = await call(arm, {}, {});
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: 'This action reaches every app: it needs access to all of them.',
    });
  });

  it('the live tail only forwards the granted app', async () => {
    const { store } = await seeded();
    setTelescopeRuntime(store, true);
    const events = new EntryEvents();
    setTelescopeEntryEvents(events);
    const { routes } = await bootConsole({ authorize });
    const stream = routes.find((r) => r.pattern.endsWith('/api/stream')) as Route;
    const written: string[] = [];
    const response = new RecordingResponse();
    const ctx = {
      request: { ...makeRequest('GET', {}, { 'x-apps': 'a' }), request: { on: () => {} } },
      response: Object.assign(response, {
        response: {
          writeHead: () => {},
          write: (chunk: string) => {
            written.push(chunk);
            return true;
          },
          on: () => {},
        },
      }),
      params: {},
    };
    await stream.handler(ctx);
    const b = await store.record({
      type: 'log',
      content: { message: 'secret-b' },
      tags: ['app:b'],
    });
    const a = await store.record({ type: 'log', content: { message: 'live-a' }, tags: ['app:a'] });
    events.publish(b);
    events.publish(a);
    const text = written.join('');
    expect(text).toContain('live-a');
    expect(text).not.toContain('secret-b');
  });

  it('a standalone app (no app tags, no apps grant) reads everything, as before', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({ type: 'log', content: { message: 'plain' }, tags: [] });
    setTelescopeRuntime(store, true);
    const { routes } = await bootConsole({ authorize: () => true });
    const entries = routes.find((r) => r.pattern.endsWith('/api/entries')) as Route;
    expect(JSON.stringify((await call(entries, {}, {})).body)).toContain('plain');
    const apps = routes.find((r) => r.pattern.endsWith('/api/apps')) as Route;
    expect((await call(apps, {}, {})).body).toEqual({
      data: { enabled: false, tag: 'app', all: true, apps: [] },
    });
  });
});
