import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeProvider from '../providers/telescope_provider.js';
import {
  ensureTelescopeExtensionsBinding,
  mergeExtensions,
  readBoundExtensions,
  TELESCOPE_EXTENSIONS_BINDING,
} from '../src/extension/binding.js';
import type { TelescopeExtension } from '../src/extension/types.js';
import { getTelescopeExtensionRegistry, resetTelescopeRuntime } from '../src/registry.js';

/** A container with real value bindings (what `bindValue`/`hasBinding`/`make` do in AdonisJS). */
function fakeContainer() {
  const values = new Map<string, unknown>();
  const debug = vi.fn();
  return {
    values,
    debug,
    hasBinding: (key: string) => values.has(key),
    bindValue: (key: string, value: unknown) => {
      values.set(key, value);
    },
    singleton: () => {},
    make: async (key: unknown) => {
      if (key === 'logger') return { debug, warn: vi.fn(), info: vi.fn() };
      if (typeof key === 'string' && values.has(key)) return values.get(key);
      return {};
    },
  };
}

function ext(name: string, dashboard = `${name}.page`): TelescopeExtension {
  return { name, dashboards: () => [{ id: dashboard, label: name, panels: [] }] };
}

function fakeApp(container: ReturnType<typeof fakeContainer>, config: Record<string, unknown>) {
  return {
    container,
    inProduction: false,
    config: { get: (key: string, fallback?: unknown) => (key === 'telescope' ? config : fallback) },
  } as unknown as ApplicationService;
}

afterEach(() => resetTelescopeRuntime());

describe("'agora.telescope.extensions' binding", () => {
  it('creates an empty array when absent and leaves an existing one alone', async () => {
    const container = fakeContainer();
    ensureTelescopeExtensionsBinding(container);
    expect(container.values.get(TELESCOPE_EXTENSIONS_BINDING)).toEqual([]);

    const pushed = container.values.get(TELESCOPE_EXTENSIONS_BINDING) as TelescopeExtension[];
    pushed.push(ext('resilience'));
    ensureTelescopeExtensionsBinding(container);
    expect(container.values.get(TELESCOPE_EXTENSIONS_BINDING)).toBe(pushed);
    expect(await readBoundExtensions(container)).toHaveLength(1);
  });

  it('reads nothing when absent, not an array, or holding junk', async () => {
    const container = fakeContainer();
    expect(await readBoundExtensions(container)).toEqual([]);
    container.values.set(TELESCOPE_EXTENSIONS_BINDING, { nope: true });
    expect(await readBoundExtensions(container)).toEqual([]);
    container.values.set(TELESCOPE_EXTENSIONS_BINDING, [null, 3, { name: '' }, ext('ok')]);
    expect((await readBoundExtensions(container)).map((e) => e.name)).toEqual(['ok']);
  });

  it('config wins on a duplicate name, reported once', () => {
    const onDuplicate = vi.fn();
    const configured = ext('resilience', 'resilience.configured');
    const merged = mergeExtensions(
      [configured],
      [ext('resilience', 'resilience.bound'), ext('resilience'), ext('payments')],
      onDuplicate,
    );
    expect(merged.map((e) => e.name)).toEqual(['resilience', 'payments']);
    expect(merged[0]).toBe(configured);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith('resilience');
  });
});

describe('TelescopeProvider reads the binding', () => {
  it('binds the array in register() and serves a bound extension with no config change', async () => {
    const container = fakeContainer();
    const provider = new TelescopeProvider(fakeApp(container, {}));
    provider.register();
    // A library pushes its extension from its own register().
    (container.values.get(TELESCOPE_EXTENSIONS_BINDING) as TelescopeExtension[]).push(
      ext('resilience'),
    );
    await provider.boot();
    expect(
      getTelescopeExtensionRegistry()
        ?.dashboards()
        .map((d) => d.id),
    ).toEqual(['resilience.page']);
    await provider.shutdown();
  });

  it('a library that registered first (binding already there) is kept', async () => {
    const container = fakeContainer();
    container.values.set(TELESCOPE_EXTENSIONS_BINDING, [ext('payments')]);
    const provider = new TelescopeProvider(fakeApp(container, {}));
    provider.register();
    await provider.boot();
    expect(
      getTelescopeExtensionRegistry()
        ?.dashboards()
        .map((d) => d.id),
    ).toEqual(['payments.page']);
    await provider.shutdown();
  });

  it('config.extensions wins over a bound extension with the same name (debug log)', async () => {
    const container = fakeContainer();
    const provider = new TelescopeProvider(
      fakeApp(container, { extensions: [ext('resilience', 'resilience.mine')] }),
    );
    provider.register();
    (container.values.get(TELESCOPE_EXTENSIONS_BINDING) as TelescopeExtension[]).push(
      ext('resilience', 'resilience.lib'),
    );
    await provider.boot();
    expect(
      getTelescopeExtensionRegistry()
        ?.dashboards()
        .map((d) => d.id),
    ).toEqual(['resilience.mine']);
    await vi.waitFor(() => expect(container.debug).toHaveBeenCalledTimes(1));
    await provider.shutdown();
  });

  it('no binding and no config → no registry (unchanged behaviour)', async () => {
    const container = fakeContainer();
    const provider = new TelescopeProvider(fakeApp(container, {}));
    await provider.boot();
    expect(getTelescopeExtensionRegistry()).toBeNull();
    await provider.shutdown();
  });
});
