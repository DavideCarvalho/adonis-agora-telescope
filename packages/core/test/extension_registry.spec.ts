import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import {
  defineTelescopeExtension,
  type ExtensionContext,
  type Panel,
  type TelescopeExtension,
} from '../src/extension/types.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

function ctx(): ExtensionContext {
  const store = new InMemoryTelescopeStore();
  return {
    store,
    container: { make: async () => undefined as never },
    config: resolveConfig({}),
  };
}

const durable: TelescopeExtension = {
  name: 'durable',
  entryTypes: () => [{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }],
  dashboards: () => [{ id: 'durable.runs', label: 'Runs', panels: [] }],
  dataProviders: () => [{ name: 'durable.state', resolve: async () => ({ value: 1 }) }],
};

describe('panel IR — paged table + trace deep-link convention', () => {
  it('accepts a table panel opting into the paged convention (and defaults it off)', () => {
    const ext = defineTelescopeExtension({
      name: 'demo',
      dashboards: () => [
        {
          id: 'demo.paged',
          label: 'Demo',
          panels: [
            {
              kind: 'table',
              title: 'Runs',
              data: { provider: 'demo.runs' },
              columns: [{ key: 'runId', label: 'Run', link: { href: '#/traces/{traceId}' } }],
              paged: true,
            },
            {
              kind: 'table',
              title: 'Recent',
              data: { provider: 'demo.recent' },
              columns: [{ key: 'runId', label: 'Run' }],
            },
          ],
        },
      ],
    });
    const panels = (ext.dashboards?.({} as ExtensionContext)[0]?.panels ?? []) as Panel[];
    const paged = panels[0];
    const unpaged = panels[1];
    expect(paged?.kind === 'table' && paged.paged).toBe(true);
    // A table column can carry the in-app trace hash-route deep link.
    expect(paged?.kind === 'table' && paged.columns[0]?.link?.href).toBe('#/traces/{traceId}');
    // Non-paged tables don't declare the field — convention default is "off".
    expect(unpaged?.kind === 'table' && unpaged.paged).toBeUndefined();
  });
});

describe('ExtensionRegistry', () => {
  it('collects entry types, dashboards, and providers (with owner)', () => {
    const reg = new ExtensionRegistry([durable], ctx());
    expect(reg.entryTypes().map((e) => e.id)).toEqual(['durable']);
    expect(reg.dashboards().map((d) => d.id)).toEqual(['durable.runs']);
    expect(reg.findProvider('durable.state')).toBeDefined();
    expect(reg.providerOwner('durable.state')).toBe('durable');
    expect(reg.findProvider('nope')).toBeUndefined();
  });

  it('throws on a duplicate provider name across extensions, naming both owners', () => {
    const other: TelescopeExtension = {
      name: 'other',
      dataProviders: () => [{ name: 'durable.state', resolve: async () => ({ value: 2 }) }],
    };
    expect(() => new ExtensionRegistry([durable, other], ctx())).toThrowError(
      /durable\.state.*durable.*other/,
    );
  });

  it('throws on a duplicate dashboard id', () => {
    const dup: TelescopeExtension = {
      name: 'dup',
      dashboards: () => [{ id: 'durable.runs', label: 'X', panels: [] }],
    };
    expect(() => new ExtensionRegistry([durable, dup], ctx())).toThrowError(/durable\.runs/);
  });

  it('throws on a duplicate entry-type id', () => {
    const dup: TelescopeExtension = {
      name: 'dup',
      entryTypes: () => [{ id: 'durable', label: 'X', dot: 'bg-red-400' }],
    };
    expect(() => new ExtensionRegistry([durable, dup], ctx())).toThrowError(/durable/);
  });

  it('accessors return copies (defensive)', () => {
    const reg = new ExtensionRegistry([durable], ctx());
    reg.entryTypes().push({ id: 'x', label: 'x', dot: 'x' });
    expect(reg.entryTypes()).toHaveLength(1);
  });
});

/**
 * The Live Schedules screen lists what `registerSchedule()` was TOLD exists. A host
 * that already knows its own schedules — a workflow engine with `@Scheduled`, say —
 * had to repeat the list by hand, and the copy drifts from the decorators on the
 * first change. This hook lets the owner answer instead.
 */
describe('ExtensionRegistry.collectSchedules', () => {
  it('coleta os schedules das extensões', async () => {
    const registry = new ExtensionRegistry(
      [
        {
          name: 'durable',
          schedules: () => [{ name: 'sync-writing', schedule: '*/2 * * * *', kind: 'cron' }],
        },
      ],
      ctx(),
    );
    expect(await registry.collectSchedules()).toEqual([
      { name: 'sync-writing', schedule: '*/2 * * * *', kind: 'cron' },
    ]);
  });

  it('aceita hook assíncrono (o dono do scheduler resolve serviço do container)', async () => {
    const registry = new ExtensionRegistry(
      [{ name: 'durable', schedules: async () => [{ name: 'a' }] }],
      ctx(),
    );
    expect(await registry.collectSchedules()).toHaveLength(1);
  });

  it('nome duplicado entre extensões entra uma vez só', async () => {
    const registry = new ExtensionRegistry(
      [
        { name: 'um', schedules: () => [{ name: 'prune' }] },
        { name: 'dois', schedules: () => [{ name: 'prune' }, { name: 'outro' }] },
      ],
      ctx(),
    );
    expect((await registry.collectSchedules()).map((s) => s.name)).toEqual(['prune', 'outro']);
  });

  it('extensão que estoura é pulada, e as outras continuam', async () => {
    // Uma lista de dashboard não vale um boot quebrado.
    const registry = new ExtensionRegistry(
      [
        {
          name: 'quebrada',
          schedules: () => {
            throw new Error('scheduler indisponível');
          },
        },
        { name: 'boa', schedules: () => [{ name: 'ok' }] },
      ],
      ctx(),
    );
    expect((await registry.collectSchedules()).map((s) => s.name)).toEqual(['ok']);
  });

  it('extensão sem o hook não atrapalha', async () => {
    const registry = new ExtensionRegistry([durable], ctx());
    expect(await registry.collectSchedules()).toEqual([]);
  });
});
