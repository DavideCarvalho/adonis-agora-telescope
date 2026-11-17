import type { Entry, RecordInput } from './entry.js';
import {
  type BucketCountQuery,
  type BucketCountRow,
  type DurationQuery,
  type DurationRow,
  type EntryQuery,
  forwardOptionalReads,
  type SlowestQuery,
  type TelescopeStore,
  type TraceIdRow,
  type TracePageQuery,
  type TraceRepeatQuery,
  type TraceRepeatRow,
} from './store.js';
import { currentTenantTags, type ResolvedTelescopeTenancy } from './tenancy.js';

/**
 * Adds the active tenant's tags (`tenant:<id>` per level, `tenant:*` inside `allTenants`) to every
 * recorded entry, deduped with tags the watcher already set (a host enrichment tagging
 * `tenant:acme` itself). Reads pass through.
 */
export class TenantTaggingStore implements TelescopeStore {
  constructor(
    private readonly inner: TelescopeStore,
    private readonly tenancy: ResolvedTelescopeTenancy,
  ) {
    forwardOptionalReads(this, inner);
  }

  record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const tags = currentTenantTags(this.tenancy);
    if (tags.length === 0) return this.inner.record(input);
    const existing = input.tags ?? [];
    const extra = tags.filter((tag) => !existing.includes(tag));
    if (extra.length === 0) return this.inner.record(input);
    return this.inner.record({ ...input, tags: [...existing, ...extra] });
  }

  get(id: string): Promise<Entry | null> {
    return this.inner.get(id);
  }

  list(query?: EntryQuery): Promise<Entry[]> {
    return this.inner.list(query);
  }

  count(): Promise<number> {
    return this.inner.count();
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.inner.prune(olderThan, keepLast);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }
}

/**
 * A read-only view of a store narrowed to entries carrying one of `tags` (the tenants a console
 * viewer may see) and, for each extra group in `also`, one of that group's tags too (the apps the
 * viewer may see). Every aggregate the console shows is computed from the viewer's own entries
 * only: no cross-tenant counts. The store's windowed aggregate fast paths (bucket counts, slowest
 * entries, per-trace repeats, timed families, keyset trace pages) are forwarded with the scope as
 * `tagGroups` only when the store declares it honors them ({@link TelescopeStore.honorsTagGroups});
 * the others (family/tag counts, offset trace-id pages) never are. `get` answers `null` for an entry
 * outside the scope. Writes
 * are refused.
 */
export class TenantScopedStore implements TelescopeStore {
  private readonly tags: Set<string>;
  private readonly also: Set<string>[];

  constructor(
    private readonly inner: TelescopeStore,
    tags: readonly string[],
    also: readonly (readonly string[])[] = [],
  ) {
    this.tags = new Set(tags);
    this.also = also.map((group) => new Set(group));
    if (inner.honorsTagGroups === true) {
      const groups = [[...this.tags], ...this.also.map((group) => [...group])];
      const self = this as unknown as Record<string, unknown>;
      const { countByBucket, listSlowest, countTraceRepeats, listDurations, pageTraceIds } = inner;
      if (countByBucket !== undefined) {
        self.countByBucket = (query: BucketCountQuery): Promise<BucketCountRow[]> =>
          countByBucket.call(inner, {
            ...query,
            tagGroups: [...(query.tagGroups ?? []), ...groups],
          });
      }
      if (listSlowest !== undefined) {
        self.listSlowest = (query: SlowestQuery): Promise<Entry[]> =>
          listSlowest.call(inner, { ...query, tagGroups: [...(query.tagGroups ?? []), ...groups] });
      }
      if (countTraceRepeats !== undefined) {
        self.countTraceRepeats = (query: TraceRepeatQuery): Promise<TraceRepeatRow[]> =>
          countTraceRepeats.call(inner, {
            ...query,
            tagGroups: [...(query.tagGroups ?? []), ...groups],
          });
      }
      if (listDurations !== undefined) {
        self.listDurations = (query: DurationQuery): Promise<DurationRow[]> =>
          listDurations.call(inner, {
            ...query,
            tagGroups: [...(query.tagGroups ?? []), ...groups],
          });
      }
      if (pageTraceIds !== undefined) {
        self.pageTraceIds = (query: TracePageQuery): Promise<TraceIdRow[]> =>
          pageTraceIds.call(inner, {
            ...query,
            tagGroups: [...(query.tagGroups ?? []), ...groups],
          });
      }
      self.honorsTagGroups = true;
    }
  }

  private visible(entry: Entry): boolean {
    return (
      entry.tags.some((tag) => this.tags.has(tag)) &&
      this.also.every((group) => entry.tags.some((tag) => group.has(tag)))
    );
  }

  record<TContent>(): Promise<Entry<TContent>> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }

  async get(id: string): Promise<Entry | null> {
    const entry = await this.inner.get(id);
    return entry !== null && this.visible(entry) ? entry : null;
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    if (this.tags.size === 0 || this.also.some((group) => group.size === 0)) return [];
    const scope = [...this.tags];
    const wanted = query.anyTags;
    if (wanted === undefined && this.also.length === 0) {
      // The store filters natively; the second pass guards against a store that ignores `anyTags`.
      const rows = await this.inner.list({ ...query, anyTags: scope });
      return rows.filter((entry) => this.visible(entry));
    }
    // The caller's own `anyTags` (and the extra groups) AND the scope: the store narrows by the
    // scope, the rest is applied here, then the page is cut.
    if (wanted !== undefined && wanted.length === 0) return [];
    const { page, size, ...rest } = query;
    const rows = (await this.inner.list({ ...rest, anyTags: scope })).filter(
      (entry) =>
        this.visible(entry) &&
        (wanted === undefined || entry.tags.some((tag) => wanted.includes(tag))),
    );
    if (size === undefined) return rows;
    const offset = (Math.max(1, Math.floor(page ?? 1)) - 1) * size;
    return rows.slice(offset, offset + size);
  }

  async count(): Promise<number> {
    return (await this.list({ omitContent: true })).length;
  }

  prune(): Promise<number> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }

  clear(): Promise<void> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }
}

/**
 * The store a console request reads: `store` itself when nothing narrows it, else a
 * {@link TenantScopedStore} over the tenant tags AND the app tags (each `null` = not narrowed).
 */
export function scopedStore(
  store: TelescopeStore,
  tenantTags: readonly string[] | null,
  appTags: readonly string[] | null,
): TelescopeStore {
  if (tenantTags === null && appTags === null) return store;
  if (tenantTags === null) return new TenantScopedStore(store, appTags ?? []);
  return new TenantScopedStore(store, tenantTags, appTags === null ? [] : [appTags]);
}

/** A cache key for a (tenant tags, app tags) pair; `null` when nothing narrows. */
export function scopeKey(
  tenantTags: readonly string[] | null,
  appTags: readonly string[] | null,
): string | null {
  if (tenantTags === null && appTags === null) return null;
  const part = (tags: readonly string[] | null) =>
    tags === null ? '*' : [...tags].sort().join('\n');
  return `${part(tenantTags)}\u0000${part(appTags)}`;
}

/** Whether `entry` is inside the (tenant tags, app tags) pair (`null` = not narrowed). */
export function entryInScope(
  entry: Pick<Entry, 'tags'>,
  tenantTags: readonly string[] | null,
  appTags: readonly string[] | null,
): boolean {
  if (tenantTags !== null && !entry.tags.some((tag) => tenantTags.includes(tag))) return false;
  if (appTags !== null && !entry.tags.some((tag) => appTags.includes(tag))) return false;
  return true;
}
