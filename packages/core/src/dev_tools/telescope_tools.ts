import type { ExceptionEntryContent } from '../ai/diagnoser.js';
import type { ResolvedTelescopeConfig } from '../define_config.js';
import { type Entry, EntryType } from '../entry.js';
import { MetricsService } from '../metrics/metrics_service.js';
import { getTelescopeRuntime } from '../registry.js';
import { TelescopeService } from '../service.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import { TenantScopedStore } from '../tenancy_store.js';
import type { GuardResult } from '../ui/guard.js';
import { consoleTenantScope, selectTenantScope } from '../ui/tenant_scope.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_HEALTH_WINDOW_MS = 60 * 60_000;

/** The arguments every tool reads (a superset; each tool picks its own). */
export interface TelescopeToolArgs {
  type?: string;
  search?: string;
  tag?: string;
  sinceMinutes?: number;
  limit?: number;
  /** 1-based page for `list_entries` (default 1). */
  page?: number;
  id?: string;
  traceId?: string;
}

const NOTICE: unique symbol = Symbol('telescope.tools.notice');

/** A "nothing to show" answer: the tool ran, there is nothing to show. */
export interface TelescopeToolNotice {
  notice: string;
  /** Brand: only `notice()` builds one, so no tool payload is mistaken for it. */
  readonly [NOTICE]: true;
}

/** Optional AI diagnosis hook — resolves the diagnosis markdown, or `null` when AI is off. */
export type DiagnoseExceptionHook = (entry: Entry) => Promise<string | null> | string | null;

/**
 * What telescope's dev tools run against: the same {@link TelescopeService} /
 * {@link MetricsService} / Pulse APIs the dashboard uses, so every answer reads stored
 * (already redacted, already sampled) entries.
 */
export class TelescopeTools {
  constructor(
    private readonly service: TelescopeService,
    private readonly metrics: MetricsService,
    private readonly diagnose?: DiagnoseExceptionHook,
  ) {}

  /**
   * One page of entries, newest first, as compact summaries: `{ items, next }` where `next` is
   * the next page number, or `null` on the last page.
   */
  async listEntries(
    args: TelescopeToolArgs,
  ): Promise<{ items: Record<string, unknown>[]; next: number | null }> {
    const size = clampLimit(args.limit);
    const page =
      typeof args.page === 'number' && Number.isFinite(args.page) && args.page >= 1
        ? Math.floor(args.page)
        : 1;
    const query: EntryQuery = {
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.search !== undefined && args.search !== '' ? { search: args.search } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      ...(typeof args.sinceMinutes === 'number'
        ? { after: new Date(Date.now() - args.sinceMinutes * 60_000) }
        : {}),
      page,
      size,
    };
    const entries = await this.service.list(query);
    // The first row AFTER this page says whether a next one exists (the offset is derived from
    // `(page - 1) * size`, so that row is `{ page: page * size + 1, size: 1 }`). Only a full page
    // can have a successor.
    const hasMore =
      entries.length === size &&
      (await this.service.list({ ...query, page: page * size + 1, size: 1 })).length > 0;
    return { items: entries.map(slim), next: hasMore ? page + 1 : null };
  }

  /**
   * Run one tool and return its structured result. A "nothing to show" answer is a
   * {@link TelescopeToolNotice}. Throws on bad input or an unknown tool.
   */
  async call(name: string | undefined, args: TelescopeToolArgs): Promise<unknown> {
    switch (name) {
      case 'list_entries':
        return this.listEntries(args);
      case 'get_entry': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        const entry = await this.service.find(args.id);
        if (entry === null) return notice('Entry not found (it may have been pruned).');
        const siblings =
          entry.traceId !== null
            ? (await this.service.byTrace(entry.traceId)).filter((e) => e.id !== entry.id)
            : [];
        return { entry, trace: siblings.map(slim) };
      }
      case 'get_trace': {
        if (typeof args.traceId !== 'string') throw new Error('`traceId` is required.');
        const entries = await this.service.byTrace(args.traceId);
        if (entries.length === 0) return notice('Trace not found (it may have been pruned).');
        return { entries };
      }
      case 'get_waterfall': {
        if (typeof args.traceId !== 'string') throw new Error('`traceId` is required.');
        const waterfall = await this.metrics.getWaterfall(args.traceId);
        if (waterfall === null) return notice('Trace not found (it may have been pruned).');
        return waterfall;
      }
      case 'get_health': {
        const windowMs =
          typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0
            ? args.sinceMinutes * 60_000
            : DEFAULT_HEALTH_WINDOW_MS;
        return this.service.getHealth({ windowMs });
      }
      case 'diagnose_exception': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        if (this.diagnose === undefined) {
          return notice('AI diagnosis is not configured on this telescope.');
        }
        const entry = await this.service.find(args.id);
        if (
          entry === null ||
          (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
        ) {
          return notice('No exception entry with that id.');
        }
        const markdown = await this.diagnose(entry);
        return markdown ?? notice('AI diagnosis returned no result.');
      }
      default:
        throw new Error(`Unknown tool: ${String(name)}`);
    }
  }

  /** Whether `diagnose_exception` has an AI coordinator behind it. */
  canDiagnose(): boolean {
    return this.diagnose !== undefined;
  }
}

function notice(text: string): TelescopeToolNotice {
  return { notice: text, [NOTICE]: true };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIST_LIMIT));
}

/** Compact projection for list payloads — agents drill in via `get_entry`/`get_trace`. */
function slim(entry: Entry): Record<string, unknown> {
  const c = (entry.content ?? {}) as Record<string, unknown>;
  let summary: string;
  switch (entry.type) {
    case EntryType.Request:
      summary = `${String(c.method)} ${String(c.url)} → ${String(c.status)}`;
      break;
    case EntryType.Query:
      summary = String(c.sql ?? '').slice(0, 200);
      break;
    case EntryType.Exception:
    case EntryType.ClientException:
      summary = `${String(c.name ?? c.class)}: ${String(c.message)}`;
      break;
    case EntryType.Log:
      summary = `${String(c.level)}: ${String(c.message)}`;
      break;
    case EntryType.Job:
      summary = `${String(c.name)} (${String(c.status)})`;
      break;
    default:
      summary = safeSummary(c, entry.type);
  }
  return {
    id: entry.id,
    type: entry.type,
    traceId: entry.traceId,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
    tags: entry.tags,
    summary,
  };
}

function safeSummary(content: Record<string, unknown>, type: string): string {
  try {
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return type;
  }
}

/**
 * Build the {@link TelescopeTools} over a store: the same services the console uses, and the AI
 * diagnosis hook when a configured coordinator is published.
 */
export function buildTelescopeTools(
  store: TelescopeStore,
  coreConfig: ResolvedTelescopeConfig,
): TelescopeTools {
  const service = new TelescopeService(store, {
    windowMs: coreConfig.pulse.windowMs,
    topN: coreConfig.pulse.topN,
    buckets: coreConfig.pulse.buckets,
    slowRouteMs: coreConfig.pulse.slowRouteMs,
    cards: coreConfig.pulse.cards,
    ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
  });
  const metrics = new MetricsService(store, {
    ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
  });
  // Without a configured coordinator `diagnose_exception` reports "not configured".
  const coordinator = getTelescopeRuntime().diagnosisCoordinator;
  const diagnose: DiagnoseExceptionHook | undefined = coordinator?.isConfigured()
    ? async (entry: Entry) => {
        // Feed the same-trace siblings as extra context (already redacted).
        const related = entry.traceId !== null ? await service.byTrace(entry.traceId) : undefined;
        return coordinator.diagnoseMarkdown(entry as Entry<ExceptionEntryContent>, {
          ...(related !== undefined ? { related } : {}),
        });
      }
    : undefined;
  return new TelescopeTools(service, metrics, diagnose);
}

/**
 * The tools for one caller: over the whole store, or (with tenancy on) over the organizations its
 * `authorize` granted (`tenants`, or the caller's own active tenant). Cached per scope.
 */
export function scopedTelescopeTools(
  store: TelescopeStore,
  coreConfig: ResolvedTelescopeConfig,
): (decision: Pick<GuardResult, 'tenants'>) => TelescopeTools {
  const shared = buildTelescopeTools(store, coreConfig);
  const cache = new Map<string, TelescopeTools>();
  return (decision) => {
    const scope = consoleTenantScope(decision, coreConfig.tenancy);
    const { tags } = selectTenantScope(scope, undefined, coreConfig.tenancy);
    if (tags === null) return shared;
    const key = [...tags].sort().join('\n');
    let tools = cache.get(key);
    if (tools === undefined) {
      tools = buildTelescopeTools(new TenantScopedStore(store, tags), coreConfig);
      if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
      cache.set(key, tools);
    }
    return tools;
  };
}
