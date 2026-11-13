import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import type { DevToolsLib } from '../src/dev_tools/contract.js';
import {
  devToolsGate,
  registerTelescopeDevTools,
  telescopeDevTools,
} from '../src/dev_tools/telescope_dev_tools.js';
import { buildTelescopeTools, TelescopeTools } from '../src/dev_tools/telescope_tools.js';
import { EntryType } from '../src/entry.js';
import { MetricsService } from '../src/metrics/metrics_service.js';
import { TelescopeService } from '../src/service.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { makeRequest, RecordingResponse } from '../src/ui/http.js';

const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PROPERTY_KEYS = new Set(['type', 'description', 'enum', 'items', 'minimum', 'maximum']);

async function seeded() {
  const store = new InMemoryTelescopeStore();
  for (let i = 0; i < 5; i++) {
    await store.record({
      type: EntryType.Request,
      content: { method: 'GET', url: `/r/${i}`, status: 200 },
      traceId: `t${i}`,
    });
  }
  return store;
}

function hub(version = 1) {
  const libs: DevToolsLib[] = [];
  return {
    libs,
    hasBinding: (key: string) => key === 'agora.devTools',
    make: async () => ({ version, register: (lib: DevToolsLib) => libs.push(lib) }),
  };
}

const ctx = (headers: Record<string, string> = {}) => ({
  request: makeRequest('POST', {}, headers),
  response: new RecordingResponse(),
});

describe('telescope dev tools', () => {
  it('are the six tools, prefixed, read-only, inside the dev-tools schema subset', async () => {
    const server = buildTelescopeTools(await seeded(), resolveConfig({}));
    const tools = telescopeDevTools(server);
    expect(tools.map((t) => t.name)).toEqual([
      'telescope_list_entries',
      'telescope_get_entry',
      'telescope_get_trace',
      'telescope_get_waterfall',
      'telescope_get_health',
      'telescope_diagnose_exception',
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(TOOL_NAME);
      expect(tool.kind).toBe('read');
      expect(
        Object.keys(tool.input).every((k) => ['type', 'properties', 'required'].includes(k)),
      ).toBe(true);
      for (const property of Object.values(tool.input.properties)) {
        for (const key of Object.keys(property)) expect(PROPERTY_KEYS.has(key)).toBe(true);
      }
    }
  });

  it('list_entries pages with { items, next } and honours the caller row cap', async () => {
    const server = buildTelescopeTools(await seeded(), resolveConfig({}));
    const list = telescopeDevTools(server)[0];
    const call = {
      ctx: {},
      caller: { id: 'dev-open', via: 'open' },
      limits: { maxRows: 2, maxBytes: 1 },
    };
    const first = (await list?.run({ limit: 50 }, call)) as {
      items: unknown[];
      next: number | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe(2);
    const last = (await list?.run({ limit: 2, page: 3 }, call)) as {
      items: unknown[];
      next: number | null;
    };
    expect(last.items).toHaveLength(1);
    expect(last.next).toBeNull();
  });

  it('get tools return the stored data, or a notice', async () => {
    const store = await seeded();
    const server = buildTelescopeTools(store, resolveConfig({}));
    const tools = telescopeDevTools(server);
    const call = {
      ctx: {},
      caller: { id: 'x', via: 'open' },
      limits: { maxRows: 100, maxBytes: 1 },
    };
    const trace = (await tools[2]?.run({ traceId: 't1' }, call)) as { entries: unknown[] };
    expect(trace.entries).toHaveLength(1);
    const missing = await tools[1]?.run({ id: 'nope' }, call);
    // What the agent receives: the JSON of the notice.
    expect(JSON.parse(JSON.stringify(missing))).toEqual({
      notice: 'Entry not found (it may have been pruned).',
    });
  });

  it('diagnose_exception is only available with an AI coordinator', async () => {
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    const metrics = new MetricsService(store);
    const without = telescopeDevTools(new TelescopeTools(service, metrics));
    expect(await without[5]?.available?.()).toBe(false);
    const withAi = telescopeDevTools(new TelescopeTools(service, metrics, async () => 'md'));
    expect(await withAi[5]?.available?.()).toBe(true);
  });

  it('the gate maps the console authorize decision and never throws', async () => {
    expect(await devToolsGate(() => true)(ctx())).toEqual({ allowed: true });
    expect(await devToolsGate(() => false)(ctx())).toEqual({ allowed: false, reason: 'forbidden' });
    expect(await devToolsGate(() => ({ redirectTo: '/login' }))(ctx())).toEqual({
      allowed: false,
      reason: 'unauthenticated',
      redirectTo: '/login',
    });
    expect(
      await devToolsGate(() => {
        throw new Error('boom');
      })(ctx()),
    ).toEqual({ allowed: false, reason: 'forbidden' });
  });
});

describe('registerTelescopeDevTools', () => {
  it('registers lib "telescope" with the console gate when the hub exists', async () => {
    const container = hub();
    const server = buildTelescopeTools(new InMemoryTelescopeStore(), resolveConfig({}));
    const ok = await registerTelescopeDevTools(container, server, () => false);
    expect(ok).toBe(true);
    expect(container.libs).toHaveLength(1);
    expect(container.libs[0]?.lib).toBe('telescope');
    expect(await container.libs[0]?.authorize(ctx())).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it('skips without a hub, on another hub version, or when the hub refuses', async () => {
    const server = buildTelescopeTools(new InMemoryTelescopeStore(), resolveConfig({}));
    const none = { hasBinding: () => false, make: async () => undefined };
    expect(await registerTelescopeDevTools(none, server, () => true)).toBe(false);

    const onMalformed = vi.fn();
    const malformed = { hasBinding: () => true, make: async () => ({}) };
    expect(await registerTelescopeDevTools(malformed, server, () => true, onMalformed)).toBe(false);
    expect(onMalformed).toHaveBeenCalledWith(
      "'agora.devTools' is bound to something that is not a dev tools hub",
    );

    const onSkip = vi.fn();
    expect(await registerTelescopeDevTools(hub(2), server, () => true, onSkip)).toBe(false);
    expect(onSkip).toHaveBeenCalledWith('dev tools hub version 2 is not supported');

    const refusing = {
      hasBinding: () => true,
      make: async () => ({
        version: 1,
        register: () => {
          throw new Error('the lib "telescope" is already registered');
        },
      }),
    };
    const onRefuse = vi.fn();
    expect(await registerTelescopeDevTools(refusing, server, () => true, onRefuse)).toBe(false);
    expect(onRefuse).toHaveBeenCalledWith('the lib "telescope" is already registered');
  });
});
