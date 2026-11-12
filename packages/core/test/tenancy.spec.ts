import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import { devToolsDecisionOf, devToolsGate } from '../src/dev_tools/telescope_dev_tools.js';
import { EntryType } from '../src/entry.js';
import { scopedMcpServers } from '../src/mcp/scoped_servers.js';
import { TelescopeService } from '../src/service.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import {
  currentTenantTags,
  resolveTenancy,
  type TenancySlotLike,
  type TenantFilterLike,
  tenancyOn,
} from '../src/tenancy.js';
import { TenantScopedStore, TenantTaggingStore } from '../src/tenancy_store.js';
import { authorizeByToken, normalizeConsoleDecision } from '../src/ui/console_authorize.js';
import { runGuard } from '../src/ui/guard.js';
import { makeRequest, RecordingResponse } from '../src/ui/http.js';
import {
  type ConsoleTenantScope,
  consoleTenantScope,
  describeTenantScope,
  selectTenantScope,
} from '../src/ui/tenant_scope.js';

const SLOT = Symbol.for('@agora/context:tenancy');

/** Install a fake `@adonis-agora/context` tenancy slot whose filter is `current()`. */
function installSlot(
  enabled: boolean,
  current: () => TenantFilterLike,
  labels: Record<string, string> = {},
): TenancySlotLike {
  const slot: TenancySlotLike = {
    version: 1,
    tenancy: () => ({ enabled }),
    tenantFilter: () => current(),
    tenantLabels: async (ids) =>
      Object.fromEntries(ids.filter((id) => id in labels).map((id) => [id, labels[id] as string])),
  };
  (globalThis as Record<symbol, unknown>)[SLOT] = slot;
  return slot;
}

const org = (id: string, slug?: string): TenantFilterLike => {
  const level =
    slug === undefined ? { id, kind: 'organization' } : { id, kind: 'organization', slug };
  return { mode: 'tenant', tenant: level, chain: [level] };
};

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

const inherit = resolveTenancy(undefined);

describe('tenancy config', () => {
  it('inherit follows config/context.ts; false opts out; no context = off', () => {
    expect(tenancyOn(inherit)).toBe(false);
    installSlot(true, () => ({ mode: 'system' }));
    expect(tenancyOn(inherit)).toBe(true);
    expect(tenancyOn(resolveTenancy(false))).toBe(false);
    installSlot(false, () => ({ mode: 'system' }));
    expect(tenancyOn(inherit)).toBe(false);
    expect(tenancyOn(resolveTenancy({ enabled: true }))).toBe(true);
    expect(resolveConfig({}).tenancy).toEqual({ enabled: 'inherit', tag: 'tenant' });
    expect(resolveConfig({ tenancy: { tag: 'org', kinds: ['organization'] } }).tenancy).toEqual({
      enabled: 'inherit',
      tag: 'org',
      kinds: ['organization'],
    });
  });

  it('a slot of another version, or a broken one, is ignored', () => {
    (globalThis as Record<symbol, unknown>)[SLOT] = { version: 2 };
    expect(tenancyOn(inherit)).toBe(false);
    installSlot(true, () => {
      throw new Error('boom');
    });
    expect(currentTenantTags(inherit)).toEqual([]);
  });
});

describe('tagging', () => {
  it('tags every level of the active tenant, tenant:* inside allTenants, nothing without one', async () => {
    let current: TenantFilterLike = { mode: 'tenantless' };
    installSlot(true, () => current);
    const inner = new InMemoryTelescopeStore();
    const store = new TenantTaggingStore(inner, inherit);

    await store.record({ type: 'log', content: {}, tags: ['a'] });
    current = {
      mode: 'tenant',
      tenant: { id: 'u1', kind: 'unit' },
      chain: [
        { id: 'c1', kind: 'clinic' },
        { id: 'u1', kind: 'unit' },
      ],
    };
    await store.record({ type: 'log', content: {}, tags: ['tenant:c1'] });
    current = { mode: 'all' };
    await store.record({ type: 'log', content: {} });

    const tags = (await inner.list()).map((e) => e.tags).reverse();
    expect(tags).toEqual([['a'], ['tenant:c1', 'tenant:u1'], ['tenant:*']]);
  });

  it('records untagged when tenancy is off (byte-identical to today)', async () => {
    installSlot(false, () => org('acme'));
    const inner = new InMemoryTelescopeStore();
    await new TenantTaggingStore(inner, inherit).record({ type: 'log', content: {}, tags: ['x'] });
    expect((await inner.list())[0]?.tags).toEqual(['x']);
  });
});

describe('scoped store', () => {
  async function seeded() {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.Exception,
      content: { class: 'E', message: 'a' },
      tags: ['tenant:acme'],
      familyHash: 'E',
    });
    await store.record({
      type: EntryType.Exception,
      content: { class: 'E', message: 'b' },
      tags: ['tenant:globex'],
      familyHash: 'E',
    });
    await store.record({
      type: EntryType.Exception,
      content: { class: 'E', message: 'c' },
      tags: ['tenant:globex'],
      familyHash: 'E',
    });
    await store.record({ type: EntryType.Log, content: {}, tags: [] });
    return store;
  }

  it('lists, gets and counts only the scope; other tenants are not found', async () => {
    const inner = await seeded();
    const acme = new TenantScopedStore(inner, ['tenant:acme']);
    expect((await acme.list()).map((e) => e.tags)).toEqual([['tenant:acme']]);
    const globexEntry = (await inner.list({ tag: 'tenant:globex' }))[0];
    expect(await acme.get(globexEntry?.id as string)).toBeNull();
    expect(await acme.count()).toBe(1);
    expect(await new TenantScopedStore(inner, []).list()).toEqual([]);
    // A caller's own anyTags is ANDed with the scope, not mistaken for it.
    const both = new TenantScopedStore(inner, ['tenant:acme', 'tenant:globex']);
    expect(await both.list({ anyTags: ['tenant:globex'] })).toHaveLength(2);
    expect(await both.list({ anyTags: ['tenant:globex'], size: 1, page: 2 })).toHaveLength(1);
    expect(await acme.list({ anyTags: ['tenant:globex'] })).toEqual([]);
    await expect(acme.record()).rejects.toThrow(/read-only/);
  });

  it('exposes no aggregate fast path, so counts never span tenants (A5)', async () => {
    const inner = await seeded();
    const acme = new TenantScopedStore(inner, ['tenant:acme']);
    expect('countFamilies' in acme).toBe(false);
    expect('countTags' in acme).toBe(false);
    const families = await new TelescopeService(acme).topFamilies(10);
    expect(families).toEqual([{ key: 'E', count: 1 }]);
  });
});

describe('console scope', () => {
  const allowed = (tenants?: '*' | string[]) =>
    runGuard({ request: makeRequest('GET'), response: new RecordingResponse() }, () =>
      tenants === undefined ? { allowed: true } : { allowed: true, tenants },
    );

  it('authorize can grant tenants; normalization keeps them', async () => {
    expect(normalizeConsoleDecision({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(normalizeConsoleDecision({ allowed: true, tenants: ['a', 2] })).toEqual({
      allowed: true,
      tenants: ['a', '2'],
    });
    expect((await allowed(['acme'])).tenants).toEqual(['acme']);
  });

  it('off → no scope; * → all; list → those; omitted → own tenant; none → empty', async () => {
    expect(consoleTenantScope({}, inherit)).toBeNull();
    installSlot(true, () => org('acme', 'acme-inc'));
    expect(consoleTenantScope({ tenants: '*' }, inherit)).toEqual({ all: true });
    expect(consoleTenantScope({ tenants: ['a', 'a', 'b'] }, inherit)).toEqual({
      all: false,
      ids: ['a', 'b'],
    });
    expect(consoleTenantScope({}, inherit)).toEqual({ all: false, ids: ['acme'], own: 'acme' });
    installSlot(true, () => ({ mode: 'tenantless' }));
    expect(consoleTenantScope({}, inherit)).toEqual({ all: false, ids: [] });
  });

  it('?tenant= narrows inside the scope; outside it reads nothing (forged), never widens', () => {
    const all = { all: true } as const;
    const some: ConsoleTenantScope = { all: false, ids: ['acme', 'globex'] };
    expect(selectTenantScope(null, 'x', inherit)).toEqual({
      tags: null,
      restricted: false,
      forged: false,
    });
    expect(selectTenantScope(all, undefined, inherit).tags).toBeNull();
    expect(selectTenantScope(all, '*', inherit).tags).toBeNull();
    expect(selectTenantScope(all, 'acme', inherit).tags).toEqual(['tenant:acme']);
    expect(selectTenantScope(some, undefined, inherit)).toEqual({
      tags: ['tenant:acme', 'tenant:globex'],
      restricted: true,
      forged: false,
    });
    expect(selectTenantScope(some, 'globex', inherit).tags).toEqual(['tenant:globex']);
    expect(selectTenantScope(some, 'initech', inherit)).toEqual({
      tags: [],
      restricted: true,
      forged: true,
    });
  });

  it('describes the picker: own by slug, others by the label resolver, known tenants for *', async () => {
    installSlot(true, () => org('acme', 'acme-inc'), { globex: 'Globex Corp' });
    const store = new InMemoryTelescopeStore();
    await store.record({ type: 'log', content: {}, tags: ['tenant:globex', 'tenant:*'] });
    await store.record({ type: 'log', content: {}, tags: ['tenant:acme'] });
    expect(
      await describeTenantScope({ all: false, ids: ['acme', 'globex'] }, inherit, store),
    ).toEqual({
      enabled: true,
      tag: 'tenant',
      all: false,
      own: { id: 'acme', label: 'acme-inc' },
      tenants: [
        { id: 'acme', label: 'acme-inc' },
        { id: 'globex', label: 'Globex Corp' },
      ],
    });
    const all = await describeTenantScope({ all: true }, inherit, store);
    expect(all.tenants.map((t) => t.id).sort()).toEqual(['acme', 'globex']);
    expect(await describeTenantScope(null, inherit, store)).toEqual({
      enabled: false,
      tag: 'tenant',
      all: true,
      tenants: [],
    });
  });

  it('authorizeByToken can grant tenants to a token holder', async () => {
    const authorize = authorizeByToken({ token: 's3cret', tenants: '*' }) as (
      ctx: unknown,
    ) => unknown;
    const ctx = { request: makeRequest('GET', {}, { authorization: 'Bearer s3cret' }) };
    expect(await authorize(ctx)).toEqual({ allowed: true, tenants: '*' });
  });
});

describe('MCP scoping', () => {
  it('each caller reads only its organizations; the dev tools gate remembers the grant', async () => {
    installSlot(true, () => ({ mode: 'tenantless' }));
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'log',
      content: { level: 'info', message: 'a' },
      tags: ['tenant:acme'],
    });
    await store.record({
      type: 'log',
      content: { level: 'info', message: 'b' },
      tags: ['tenant:globex'],
    });
    const serverFor = scopedMcpServers(store, resolveConfig({}));
    const count = async (tenants?: '*' | string[]) =>
      (await serverFor(tenants === undefined ? {} : { tenants }).listEntries({})).items.length;
    expect(await count('*')).toBe(2);
    expect(await count(['acme'])).toBe(1);
    expect(await count()).toBe(0);
    expect(serverFor({ tenants: ['acme'] })).toBe(serverFor({ tenants: ['acme'] }));

    const ctx = { request: makeRequest('POST'), response: new RecordingResponse() };
    await devToolsGate(() => ({ allowed: true, tenants: ['globex'] }))(ctx);
    expect(devToolsDecisionOf(ctx)).toMatchObject({ tenants: ['globex'] });
    expect(devToolsDecisionOf({})).toEqual({});
  });
});
