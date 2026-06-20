import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import type { ExtensionContext, TelescopeExtension } from '../src/extension/types.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';

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
