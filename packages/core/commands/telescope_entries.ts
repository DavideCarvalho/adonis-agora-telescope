import { writeFile } from 'node:fs/promises';
import { args, flags } from '@adonisjs/core/ace';
import type { EntrySummary } from '../src/ui/api.js';
import { MAX_LIST_SIZE } from '../src/ui/list_api.js';
import { CliUsageError, cell, instantFlag, intFlag, TelescopeCommand } from './shared.js';

/** The entry feed's filters (`filter[...]`, `search`), shared by list and export. */
abstract class EntryFeedCommand extends TelescopeCommand {
  @flags.string({ description: 'Entry type: request, query, exception, log, job, …' })
  declare type?: string;

  @flags.array({ description: 'Tag, e.g. status:500 (repeat: any of them)' })
  declare tag?: string[];

  @flags.string({ description: 'Trace id' })
  declare trace?: string;

  @flags.string({ description: 'Family hash (the grouping key: exception family, query shape…)' })
  declare family?: string;

  @flags.string({ description: 'Free text over content and tags' })
  declare search?: string;

  @flags.string({ description: 'Recorded since: a duration ago (15m, 2h, 1d) or an ISO date' })
  declare since?: string;

  @flags.string({ description: 'Recorded before: a duration ago or an ISO date' })
  declare until?: string;

  /** The console's query string for these flags. */
  protected feedQuery(): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (this.type) filter.type = this.type;
    if (this.tag && this.tag.length > 0) filter.tag = this.tag;
    if (this.trace) filter.traceId = this.trace;
    if (this.family) filter.familyHash = this.family;
    const createdAt: Record<string, string> = {};
    if (this.since) createdAt.gte = instantFlag(this.since, 'since');
    if (this.until) createdAt.lt = instantFlag(this.until, 'until');
    if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;
    return {
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
      ...(this.search ? { search: this.search } : {}),
    };
  }
}

const ENTRY_COLUMNS = ['id', 'type', 'createdAt', 'durationMs', 'summary'];

/** `telescope:entries:list`: the console's Entries feed. */
export class TelescopeEntriesList extends EntryFeedCommand {
  static override commandName = 'telescope:entries:list';
  static override description = 'List recorded entries, newest first (filters, cursor paging)';

  @flags.string({ description: `Page size (default 50, max ${MAX_LIST_SIZE})` })
  declare first?: string;

  @flags.string({ description: 'Cursor: continue after this meta.nextCursor' })
  declare after?: string;

  override async run() {
    const { apis } = await this.console();
    const first = intFlag(this.first, 'first');
    const body = await this.handle((ctx) => apis.api.list(ctx), {
      ...this.feedQuery(),
      ...(first !== undefined ? { first } : {}),
      ...(this.after ? { after: this.after } : {}),
    });
    if (this.json) return this.printJson(body);
    this.table(body.data as EntrySummary[] as never, ENTRY_COLUMNS);
    const meta = body.meta as { nextCursor: string | null };
    if (meta.nextCursor) this.logger.info(`next page: --after ${meta.nextCursor}`);
  }
}

/** `telescope:entries:show`: one entry, its full content, and the rest of its trace. */
export class TelescopeEntriesShow extends TelescopeCommand {
  static override commandName = 'telescope:entries:show';
  static override description = 'Show one entry with its full content and its trace siblings';

  @args.string({ description: 'Entry id' })
  declare id: string;

  override async run() {
    const { apis, tools } = await this.console();
    const body = await this.handle((ctx) => apis.api.show(ctx, this.id));
    const entry = body.data as Record<string, unknown>;
    // The trace siblings, as the `telescope_get_entry` dev tool lists them.
    const detail = (await tools.call('get_entry', { id: this.id })) as {
      trace?: Array<Record<string, unknown>>;
    };
    const trace = detail.trace ?? [];
    if (this.json) return this.printJson({ data: entry, trace });
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    for (const key of ['id', 'type', 'createdAt', 'durationMs', 'traceId', 'familyHash']) {
      table.row([key, cell(entry[key])]);
    }
    table.row(['tags', ((entry.tags as string[]) ?? []).join(', ')]);
    table.render();
    this.logger.log(JSON.stringify(entry.content, null, 2));
    if (trace.length > 0) {
      this.logger.info(
        `${trace.length} other entr${trace.length === 1 ? 'y' : 'ies'} in the trace`,
      );
      this.table(trace, ['id', 'type', 'durationMs', 'summary']);
    }
  }
}

/** `telescope:entries:export`: the console's Exports workbench, to a file or stdout. */
export class TelescopeEntriesExport extends EntryFeedCommand {
  static override commandName = 'telescope:entries:export';
  static override description = 'Export filtered entries as JSON or CSV (to a file or stdout)';

  @flags.string({ description: 'json (default) or csv' })
  declare format?: string;

  @flags.string({ description: 'Most entries to export (default 500)' })
  declare limit?: string;

  @flags.string({ description: 'Write to this file instead of stdout' })
  declare output?: string;

  override async run() {
    const format = this.format ?? 'json';
    if (format !== 'json' && format !== 'csv')
      throw new CliUsageError('--format must be json or csv');
    const limit = intFlag(this.limit, 'limit') ?? 500;
    const { apis } = await this.console();
    const rows: EntrySummary[] = [];
    let after: string | null = null;
    // Walk the feed the way the console pages it, until the limit or the end.
    while (rows.length < limit) {
      const first = Math.min(MAX_LIST_SIZE, limit - rows.length);
      const body = await this.handle((ctx) => apis.api.list(ctx), {
        ...this.feedQuery(),
        first,
        ...(after !== null ? { after } : {}),
      });
      rows.push(...(body.data as EntrySummary[]));
      after = (body.meta as { nextCursor: string | null }).nextCursor;
      if (after === null) break;
    }
    const text = format === 'json' ? JSON.stringify(rows, null, 2) : entriesToCsv(rows);
    if (this.output === undefined) {
      this.logger.log(text);
      return;
    }
    await writeFile(this.output, text, 'utf8');
    if (this.json) return this.printJson({ file: this.output, format, rows: rows.length });
    this.logger.success(`${rows.length} entries written to ${this.output} (${format})`);
  }
}

const CSV_HEADER = [
  'id',
  'type',
  'createdAt',
  'durationMs',
  'tags',
  'familyHash',
  'traceId',
  'summary',
];

/** The console's export CSV: RFC 4180, CRLF rows, the same columns. Exported for tests. */
export function entriesToCsv(entries: EntrySummary[]): string {
  const csvCell = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const rows = entries.map((e) =>
    [
      e.id,
      e.type,
      e.createdAt,
      e.durationMs === null ? '' : String(e.durationMs),
      e.tags.join('; '),
      e.familyHash ?? '',
      e.traceId ?? '',
      e.summary,
    ]
      .map(csvCell)
      .join(','),
  );
  return [CSV_HEADER.join(','), ...rows].join('\r\n');
}

/** `telescope:entries:prune`: delete entries older than a cutoff (the pruner's cycle, on demand). */
export class TelescopeEntriesPrune extends TelescopeCommand {
  static override commandName = 'telescope:entries:prune';
  static override description =
    'Delete entries older than a cutoff (default: the configured prune.after)';

  @flags.string({ description: 'Age cutoff, e.g. 24h, 7d (default: config prune.after)' })
  declare olderThan?: string;

  @flags.string({
    description: 'Keep at least the newest N entries (default: config prune.keepLast)',
  })
  declare keepLast?: string;

  @flags.boolean({ description: 'Count what would be deleted, delete nothing' })
  declare dryRun?: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    this.refuseScoped('Pruning');
    const { store, coreConfig } = await this.console();
    const afterMs =
      this.olderThan !== undefined ? instantAge(this.olderThan) : coreConfig.prune.afterMs;
    const keepLast = intFlag(this.keepLast, 'keep-last') ?? coreConfig.prune.keepLast;
    const cutoff = new Date(Date.now() - afterMs);
    if (this.dryRun) {
      const older = await countOlder(store, cutoff);
      // The store keeps the newest `keepLast` of the entries past the cutoff.
      const wouldDelete = Math.max(0, older.count - (keepLast ?? 0));
      const result = {
        dryRun: true,
        cutoff: cutoff.toISOString(),
        keepLast: keepLast ?? null,
        olderThanCutoff: older.count,
        wouldDelete,
        capped: older.capped,
      };
      if (this.json) return this.printJson(result);
      const atLeast = older.capped ? 'at least ' : '';
      this.logger.info(
        `would delete ${atLeast}${wouldDelete} of the ${atLeast}${older.count} entries recorded before ${result.cutoff}${keepLast !== undefined ? ` (keeping the newest ${keepLast})` : ''}`,
      );
      return;
    }
    if (
      !(await this.confirmed(
        this.force,
        `Delete every entry recorded before ${cutoff.toISOString()}?`,
      ))
    ) {
      return;
    }
    const deleted = await store.prune(cutoff, keepLast);
    if (this.json) {
      return this.printJson({ cutoff: cutoff.toISOString(), keepLast: keepLast ?? null, deleted });
    }
    this.logger.success(`deleted ${deleted} entries recorded before ${cutoff.toISOString()}`);
  }
}

/** `telescope:entries:clear`: delete every entry. */
export class TelescopeEntriesClear extends TelescopeCommand {
  static override commandName = 'telescope:entries:clear';
  static override description = 'Delete every recorded entry';

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    this.refuseScoped('Clearing');
    const { store } = await this.console();
    if (!(await this.confirmed(this.force, 'Delete every telescope entry?'))) return;
    await store.clear();
    if (this.json) return this.printJson({ cleared: true });
    this.logger.success('every telescope entry deleted');
  }
}

/** `--older-than` → ms. */
function instantAge(value: string): number {
  const at = Date.parse(instantFlag(value, 'older-than'));
  return Math.max(0, Date.now() - at);
}

const DRY_RUN_CAP = 100_000;

/** How many entries were recorded before `cutoff` (counted up to a cap, without content). */
async function countOlder(
  store: { list(q: Record<string, unknown>): Promise<unknown[]> },
  cutoff: Date,
): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  const size = 1000;
  for (let page = 1; count < DRY_RUN_CAP; page++) {
    const rows = await store.list({ before: cutoff, page, size, omitContent: true });
    count += rows.length;
    if (rows.length < size) return { count, capped: false };
  }
  return { count, capped: true };
}
