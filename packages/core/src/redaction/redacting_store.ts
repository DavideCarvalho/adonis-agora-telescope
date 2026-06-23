import type { Entry, RecordInput } from '../entry.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import {
  type CompiledRedactSpec,
  type RedactOptions,
  compileRedactSpec,
  redactBoundedWith,
} from './redact.js';

/**
 * The CENTRAL redaction choke point. A {@link TelescopeStore} decorator whose
 * `record()` masks the entry's `content` (and `tags`) through {@link redactBoundedWith}
 * BEFORE delegating to the inner store — every other operation passes through
 * untouched.
 *
 * Wiring redaction here, at the one boundary every watcher records through
 * (`request`, `exception`, `diagnostic`, `lucid query` bindings, `mail`, `cache`,
 * and any custom watcher), guarantees no watcher can bypass it: there is exactly
 * one write path and it always scrubs. The key/path Sets are compiled ONCE at
 * construction so the per-entry hot path never rebuilds them.
 */
export class RedactingTelescopeStore implements TelescopeStore {
  private readonly spec: CompiledRedactSpec;

  constructor(
    private readonly inner: TelescopeStore,
    private readonly options: RedactOptions = {},
  ) {
    this.spec = compileRedactSpec(options);
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const redacted: RecordInput<TContent> = {
      ...input,
      content: redactBoundedWith(input.content, this.options, this.spec).value as TContent,
    };
    if (input.tags !== undefined) {
      redacted.tags = redactBoundedWith(input.tags, this.options, this.spec).value as string[];
    }
    return this.inner.record(redacted);
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
