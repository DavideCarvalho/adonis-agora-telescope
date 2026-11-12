import type { Entry, RecordInput } from './entry.js';
import { type EntryQuery, forwardOptionalReads, type TelescopeStore } from './store.js';
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
 * viewer may see). It never forwards the store's aggregate fast paths (bucket/family/tag counts,
 * trace-id pages), so every aggregate the console shows is computed from the viewer's own entries
 * only: no cross-tenant counts. `get` answers `null` for an entry outside the scope. Writes are
 * refused.
 */
export class TenantScopedStore implements TelescopeStore {
  private readonly tags: Set<string>;

  constructor(
    private readonly inner: TelescopeStore,
    tags: readonly string[],
  ) {
    this.tags = new Set(tags);
  }

  private visible(entry: Entry): boolean {
    return entry.tags.some((tag) => this.tags.has(tag));
  }

  record<TContent>(): Promise<Entry<TContent>> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }

  async get(id: string): Promise<Entry | null> {
    const entry = await this.inner.get(id);
    return entry !== null && this.visible(entry) ? entry : null;
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    if (this.tags.size === 0) return [];
    const anyTags =
      query.anyTags !== undefined
        ? query.anyTags.filter((tag) => this.tags.has(tag))
        : [...this.tags];
    if (anyTags.length === 0) return [];
    // The store filters natively; the second pass guards against a store that ignores `anyTags`.
    const rows = await this.inner.list({ ...query, anyTags });
    return rows.filter((entry) => this.visible(entry));
  }

  async count(): Promise<number> {
    return (await this.list({})).length;
  }

  prune(): Promise<number> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }

  clear(): Promise<void> {
    return Promise.reject(new Error('A tenant-scoped telescope view is read-only.'));
  }
}
