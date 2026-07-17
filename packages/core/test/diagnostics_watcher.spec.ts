import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiagnosticEvent, DiagnosticsRegistry } from '../src/diagnostics_registry.js';
import {
  DIAGNOSTIC_ENTRY_TYPE,
  DiagnosticsWatcher,
  buildDiagnosticEntry,
} from '../src/diagnostics_watcher.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

const REGISTRY_KEY = Symbol.for('@agora/diagnostics:registry');

/**
 * Stand-in for what `@adonis-agora/diagnostics` publishes on the global slot. The real
 * package's `registerChannel(name)` adds to `channels` and notifies `listeners`;
 * we replicate that contract here so the watcher integrates exactly as in prod.
 */
function installRegistry(): DiagnosticsRegistry {
  const registry: DiagnosticsRegistry = {
    channels: new Set<string>(),
    listeners: new Set<(name: string) => void>(),
  };
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
  return registry;
}

function registerChannel(registry: DiagnosticsRegistry, name: string): void {
  if (registry.channels.has(name)) return;
  registry.channels.add(name);
  for (const listener of registry.listeners) listener(name);
}

/**
 * The watcher records via a fire-and-forget `void store.record(...)` (it runs
 * inside a synchronous diagnostics_channel subscriber and cannot await). Flushing
 * the microtask + macrotask queue lets that record settle before we assert.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function envelope(over: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    v: 1,
    ts: Date.now(),
    lib: 'billing',
    event: 'invoice-paid',
    traceId: 'trace-123',
    payload: { invoiceId: 'inv_1' },
    ...over,
  };
}

describe('DiagnosticsWatcher', () => {
  let registry: DiagnosticsRegistry;

  beforeEach(() => {
    registry = installRegistry();
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  it('records a publish on a channel registered BEFORE start', async () => {
    const channelName = 'agora:billing:invoice-paid:before';
    registerChannel(registry, channelName);

    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();

    diagnostics_channel.channel(channelName).publish(envelope());
    await flush();

    const entries = await store.list({ type: DIAGNOSTIC_ENTRY_TYPE });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.familyHash).toBe('billing:invoice-paid');
    expect(entry?.tags).toContain('lib:billing');
    expect(entry?.tags).toContain('event:invoice-paid');
    expect(entry?.traceId).toBe('trace-123');

    watcher.stop();
  });

  it('subscribes to a channel registered AFTER start (future channels)', async () => {
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();

    const channelName = 'agora:mailer:sent:after';
    registerChannel(registry, channelName);
    diagnostics_channel.channel(channelName).publish(envelope({ lib: 'mailer', event: 'sent' }));
    await flush();

    expect(await store.list({ tag: 'lib:mailer' })).toHaveLength(1);
    watcher.stop();
  });

  it('ignores malformed envelopes', async () => {
    const channelName = 'agora:bad:event';
    registerChannel(registry, channelName);
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();

    diagnostics_channel.channel(channelName).publish({ not: 'an envelope' });
    diagnostics_channel.channel(channelName).publish(null);
    await flush();

    expect(await store.count()).toBe(0);
    watcher.stop();
  });

  it('stop unsubscribes so later publishes are not recorded', async () => {
    const channelName = 'agora:billing:invoice-paid:stop';
    registerChannel(registry, channelName);
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();

    diagnostics_channel.channel(channelName).publish(envelope());
    await flush();
    expect(await store.count()).toBe(1);

    watcher.stop();
    diagnostics_channel.channel(channelName).publish(envelope());
    await flush();
    expect(await store.count()).toBe(1);
  });

  it('is a no-op when the diagnostics registry is absent', async () => {
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    expect(() => watcher.start()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
    expect(await store.count()).toBe(0);
  });

  it('skips events whose lib:event is in the exclude set (only the muted event is dropped)', async () => {
    const progressChannel = 'agora:media:upload.progress';
    const completeChannel = 'agora:media:upload.complete';
    registerChannel(registry, progressChannel);
    registerChannel(registry, completeChannel);

    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store, { exclude: ['media:upload.progress'] });
    watcher.start();

    // Muted: high-frequency progress channel is in the exclude set.
    diagnostics_channel
      .channel(progressChannel)
      .publish(envelope({ lib: 'media', event: 'upload.progress' }));
    diagnostics_channel
      .channel(progressChannel)
      .publish(envelope({ lib: 'media', event: 'upload.progress' }));
    // Kept: a sibling event on the same lib is NOT muted.
    diagnostics_channel
      .channel(completeChannel)
      .publish(envelope({ lib: 'media', event: 'upload.complete' }));
    await flush();

    const entries = await store.list({ type: DIAGNOSTIC_ENTRY_TYPE });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.familyHash).toBe('media:upload.complete');

    watcher.stop();
  });

  it('records everything when no exclude set is configured', async () => {
    const channelName = 'agora:media:upload.progress:default';
    registerChannel(registry, channelName);
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();

    diagnostics_channel
      .channel(channelName)
      .publish(envelope({ lib: 'media', event: 'upload.progress' }));
    await flush();

    expect(await store.count()).toBe(1);
    watcher.stop();
  });

  it('start is idempotent (no double subscription)', async () => {
    const channelName = 'agora:billing:invoice-paid:idem';
    registerChannel(registry, channelName);
    const store = new InMemoryTelescopeStore();
    const watcher = new DiagnosticsWatcher(store);
    watcher.start();
    watcher.start();

    diagnostics_channel.channel(channelName).publish(envelope());
    await flush();
    expect(await store.count()).toBe(1);
    watcher.stop();
  });

  it('buildDiagnosticEntry tolerates a legacy envelope without v / traceId', () => {
    const input = buildDiagnosticEntry({
      ts: 123,
      lib: 'cache',
      event: 'hit',
      payload: { key: 'k' },
    } as DiagnosticEvent);
    expect(input.content.v).toBeNull();
    expect(input.content.traceId).toBeNull();
    expect(input.familyHash).toBe('cache:hit');
    expect(input.tags).not.toContain('trace:');
  });
});
