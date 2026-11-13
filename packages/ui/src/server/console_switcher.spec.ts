import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telescopeConsoleSearch } from './console_search.js';
import {
  AGORA_CONSOLES_BINDING,
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  countOtherConsoles,
  listVisibleConsoles,
  readAgoraConsoles,
  registerAgoraConsole,
  searchConsoles,
} from './console_switcher.js';
import { injectApiBase } from './paths.js';

function fakeApp() {
  const values = new Map<string, unknown>();
  return {
    values,
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => {
        values.set(key, value);
      },
      make: async (key: string) => values.get(key),
    },
  };
}

function entry(id: string, overrides: Partial<AgoraConsoleEntry> = {}): AgoraConsoleEntry {
  return {
    id,
    title: id,
    icon: 'generic',
    path: `/${id}`,
    order: 50,
    authorize: async () => ({ allowed: true }),
    ...overrides,
  };
}

const registryOf = (...entries: AgoraConsoleEntry[]): AgoraConsoleRegistry => ({
  version: 1,
  entries,
});
const ctx = () => ({}) as HttpContext;

afterEach(() => vi.useRealTimers());

describe('registerAgoraConsole', () => {
  it('creates the binding when absent and reuses it (two helpers, one registry)', async () => {
    const app = fakeApp();
    expect(await registerAgoraConsole(app, entry('telescope'))).toBe(true);
    // Another lib's copy of the helper pushes into the same value.
    (app.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry).entries.push(entry('durable'));
    const registry = await readAgoraConsoles(app);
    expect(registry?.entries.map((e) => e.id)).toEqual(['telescope', 'durable']);
    expect(countOtherConsoles(registry, 'telescope')).toBe(1);
  });

  it('skips another registry version, warns on a duplicate id, rejects a bad id/path', async () => {
    const app = fakeApp();
    app.values.set(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    expect(await registerAgoraConsole(app, entry('telescope'))).toBe(false);

    const fresh = fakeApp();
    const warn = vi.fn();
    await registerAgoraConsole(fresh, entry('telescope'));
    expect(await registerAgoraConsole(fresh, entry('telescope'), { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[@adonis-agora/telescope-ui] console id "telescope" already registered',
    );
    await expect(registerAgoraConsole(fresh, entry('Bad id'))).rejects.toThrow(/must match/);
    await expect(registerAgoraConsole(fresh, entry('x', { path: '//evil' }))).rejects.toThrow(
      /same-origin/,
    );
  });
});

describe('listVisibleConsoles', () => {
  it('only allowed, self excluded, sorted by order then id, no reasons', async () => {
    const body = await listVisibleConsoles(
      registryOf(
        entry('telescope', { order: 20 }),
        entry('media', { order: 50 }),
        entry('durable', { order: 10, icon: 'workflow' }),
        entry('payments', { order: 40, authorize: async () => ({ allowed: false }) }),
        entry('agent', {
          order: 30,
          authorize: async () => ({ allowed: false, redirectTo: '/l' }),
        }),
        entry('authkit', { order: 90, authorize: () => Promise.reject(new Error('x')) }),
      ),
      'telescope',
      ctx(),
    );
    expect(body).toEqual({
      version: 1,
      current: 'telescope',
      consoles: [
        { id: 'durable', title: 'durable', icon: 'workflow', href: '/durable' },
        { id: 'media', title: 'media', icon: 'generic', href: '/media' },
      ],
    });
  });

  it('runs gates in parallel; one slower than 300 ms is hidden', async () => {
    vi.useFakeTimers();
    const slow = entry('slow', {
      authorize: () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 1000)),
    });
    const fast = entry('fast', {
      authorize: () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 200)),
    });
    const pending = listVisibleConsoles(registryOf(slow, fast), 'telescope', ctx());
    await vi.advanceTimersByTimeAsync(301);
    const body = await pending;
    expect(body.consoles.map((c) => c.id)).toEqual(['fast']);
  });

  it('marks ctx.agoraProbe while gates run, then restores it', async () => {
    const seen: unknown[] = [];
    const c = {} as HttpContext & { agoraProbe?: boolean };
    await listVisibleConsoles(
      registryOf(
        entry('durable', {
          authorize: async (x) => {
            seen.push((x as { agoraProbe?: boolean }).agoraProbe);
            return { allowed: true };
          },
        }),
      ),
      'telescope',
      c,
    );
    expect(seen).toEqual([true]);
    expect('agoraProbe' in c).toBe(false);
  });
});

describe('searchConsoles', () => {
  it('searches self without its gate and the others only when allowed', async () => {
    const selfGate = vi.fn(async () => ({ allowed: false }));
    const deniedSearch = vi.fn(async () => [{ title: 'secret', href: '/payments/x' }]);
    const body = await searchConsoles(
      registryOf(
        entry('telescope', {
          order: 20,
          authorize: selfGate,
          search: async () => [{ title: 'GET /a', href: '/telescope#/entries/1' }],
        }),
        entry('durable', {
          order: 10,
          search: async () => [
            { title: 'run 1', href: '/durable/runs/1' },
            { title: 'bad', href: 'https://evil' },
          ],
        }),
        entry('payments', { authorize: async () => ({ allowed: false }), search: deniedSearch }),
      ),
      'telescope',
      ctx(),
      'abc',
    );
    expect(selfGate).not.toHaveBeenCalled();
    expect(deniedSearch).not.toHaveBeenCalled();
    expect(body.groups.map((g) => [g.id, g.hits.map((h) => h.title)])).toEqual([
      ['durable', ['run 1']],
      ['telescope', ['GET /a']],
    ]);
  });

  it('an empty query searches nothing', async () => {
    const search = vi.fn(async () => []);
    const body = await searchConsoles(registryOf(entry('a', { search })), 'telescope', ctx(), ' ');
    expect(body.groups).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('telescope search provider', () => {
  const at = new Date('2026-11-11T00:00:00Z');
  const store = {
    get: async (id: string) =>
      id === 'e1'
        ? {
            id: 'e1',
            type: 'request',
            traceId: 't1',
            content: { method: 'GET', url: '/a', status: 200 },
            createdAt: at,
          }
        : null,
    list: async (q: { search?: string; traceId?: string }) => {
      if (q.traceId === 't1')
        return [{ id: 'e1', type: 'request', traceId: 't1', content: {}, createdAt: at }];
      if (q.search === 'boom')
        return [
          {
            id: 'e2',
            type: 'exception',
            traceId: null,
            content: { name: 'Error', message: 'boom' },
            createdAt: at,
          },
        ];
      return [];
    },
  };

  it('opens an entry or a trace by id, else searches content', async () => {
    const search = telescopeConsoleSearch(() => store, '/telescope');
    expect(await search(ctx(), 'e1', 5)).toEqual([
      {
        title: 'GET /a → 200',
        subtitle: 'request · 2026-11-11T00:00:00.000Z',
        href: '/telescope#/entries/e1',
      },
    ]);
    expect((await search(ctx(), 't1', 5))[0]?.href).toBe('/telescope#/traces/t1');
    expect(await search(ctx(), 'boom', 5)).toEqual([
      {
        title: 'Error: boom',
        subtitle: 'exception · 2026-11-11T00:00:00.000Z',
        href: '/telescope#/entries/e2',
      },
    ]);
  });

  it('a root mount links to /#/…, no store → no hits', async () => {
    expect((await telescopeConsoleSearch(() => store, '/')(ctx(), 'e1', 5))[0]?.href).toBe(
      '/#/entries/e1',
    );
    expect(await telescopeConsoleSearch(() => null, '/telescope')(ctx(), 'e1', 5)).toEqual([]);
  });
});

describe('shell data block', () => {
  it('carries switcher/search/viewer/signOut when given, apiBase always, and escapes <', () => {
    const html = injectApiBase('<head></head>', '/telescope/api', {
      switcher: { endpoint: '/telescope/api/consoles', others: 2 },
      search: { endpoint: '/telescope/api/consoles/search' },
      viewer: { label: '</script><b>', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 't' },
    });
    const json = /<script type="application\/json"[^>]*>(.*)<\/script>/.exec(html)?.[1] ?? '';
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toEqual({
      switcher: { endpoint: '/telescope/api/consoles', others: 2 },
      search: { endpoint: '/telescope/api/consoles/search' },
      viewer: { label: '</script><b>', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 't' },
      apiBase: '/telescope/api',
    });
    expect(injectApiBase('<head></head>', '/x/api')).toContain('{"apiBase":"/x/api"}');
  });
});
