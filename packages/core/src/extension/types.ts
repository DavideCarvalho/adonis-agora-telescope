import type { ResolvedTelescopeConfig } from '../define_config.js';
import type { TelescopeStore } from '../store.js';

/**
 * The published, versioned extension contract for `@adonis-agora/telescope`.
 *
 * An extension is a plain object (usually returned by a factory so it can take options), registered
 * via `config/telescope.ts`'s `extensions: [...]`. The provider runs its hooks once at boot. Hooks
 * are **multi** (every extension runs; results accumulate). A sibling lib (e.g. `@adonis-agora/durable`)
 * contributes navigable entry types, declarative dashboard pages, and the server-side data providers
 * those pages bind to — without `@adonis-agora/telescope` knowing anything about it.
 *
 * @remarks Semver 0.x — the shape may change until 1.0.
 */
import type { ScheduleRegistration } from '../watchers/schedule_watcher.js';

export interface TelescopeExtension {
  /** Unique id — used in collision errors and for deterministic ordering. */
  name: string;
  /** Contribute navigable entry types — makes the UI's entry-type nav dynamic. */
  entryTypes?(ctx: ExtensionContext): ExtensionEntryType[];
  /** Contribute declarative dashboard pages (the panel IR). */
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  /** Named server-side queries that panels bind to via `{ provider, query }`. */
  dataProviders?(ctx: ExtensionContext): DataProvider[];
  /**
   * Contribute known scheduled tasks to the Live Schedules screen.
   *
   * That screen lists what `registerSchedule()` was TOLD exists, which means a host
   * that already knows its own schedules — a workflow engine with a `@Scheduled`
   * decorator, say — still had to repeat the list by hand, and the copy drifts from
   * the decorators on the first change. An extension that owns a scheduler can
   * answer here instead, and the list stays derived from the real source.
   *
   * Called once at boot, alongside the other hooks. Contributions are merged with
   * anything registered imperatively; a name registered both ways is registered once.
   */
  schedules?(ctx: ExtensionContext): ScheduleContribution[] | Promise<ScheduleContribution[]>;
}

/**
 * A scheduled task an extension knows about.
 *
 * An ALIAS of {@link ScheduleRegistration}, not a copy of it: a second declaration of
 * the same shape is a second place for `ScheduleKind` to drift, and the drift shows
 * up as a type error in the provider rather than anywhere near the mistake.
 */
export type ScheduleContribution = ScheduleRegistration;

/** The slice of the AdonisJS container an extension needs to resolve host services. */
export interface ContainerLike {
  make<T>(token: unknown): Promise<T>;
}

/**
 * Read-only context handed to every extension hook at boot. Replaces NestJS's `ModuleRef`: the
 * telescope `store` is passed directly (for reading recorded entries), and `container` resolves host
 * services — e.g. a durable provider does `await ctx.container.make(WorkflowEngine)`.
 */
export interface ExtensionContext {
  /** The telescope store — read recorded entries for aggregation. */
  readonly store: TelescopeStore;
  /** Resolve host services (e.g. a durable `WorkflowEngine`) from the app container. */
  readonly container: ContainerLike;
  /** The resolved telescope config. */
  readonly config: ResolvedTelescopeConfig;
}

/** A navigable entry type contributed by an extension (subset of the UI's entry-type nav). */
export interface ExtensionEntryType {
  /** Backend `type`/`tag` filter value, e.g. 'durable'. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Tailwind `bg-*` dot color for the nav, e.g. 'bg-amber-400'. */
  dot: string;
}

/** Threshold coloring for a numeric panel. `direction` says which way is worse. */
export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

/** A group of panels rendered together with its own column count. */
export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

/** A declarative dashboard page. */
export interface DashboardSpec {
  /** Stable route id, e.g. 'durable.workflows'. Globally unique across extensions. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Optional nav grouping header. */
  navGroup?: string;
  /** Flat layout. Prefer `sections` for hierarchy. */
  panels: Panel[];
  /** Sectioned layout. When present, the UI renders these instead of `panels`. */
  sections?: DashboardSection[];
}

/** A bind from a panel to a named server-side provider + an opaque query object. */
export interface DataBinding {
  /** Provider name, e.g. 'durable.timeseries'. Resolved on the server. */
  provider: string;
  /** Opaque query passed through to the provider's `resolve`. */
  query?: Record<string, unknown>;
}

/**
 * A deep-link out of a table cell (to the durable dashboard, a telescope trace, etc.).
 *
 * @remarks Two href conventions:
 *  - **In-app hash route** — an `href` starting with `#/` (e.g. `'#/traces/{traceId}'`)
 *    is a route inside the Telescope SPA itself. The UI renders it as a plain
 *    anchor; browsers treat a same-document `#`-only href as a same-document
 *    navigation (URL hash update + `hashchange`, no page reload), which the
 *    dashboard's hash router picks up — the same mechanism the built-in Entries
 *    table and Entry detail view already use for their own trace links. Leave
 *    `external` unset for these.
 *  - **Host-console link** — an absolute path with no `#` (e.g.
 *    `'/durable/runs/{runId}'`) targets a page in the HOST application (the app
 *    embedding/linking to Telescope), not a Telescope route. This is a real
 *    top-level navigation; set `external: true` when it should open in a new tab.
 *
 * The one confirmed in-app hash route today is the trace waterfall view:
 * `#/traces/{traceId}` (`traceId` is the row key to substitute), which shows the
 * single-trace waterfall. Bridges that want to deep-link a table row to "show me
 * this trace" should target that exact shape.
 */
export interface LinkSpec {
  /** A URL template with `{key}` placeholders filled from the row, e.g. '/durable/runs/{runId}'. */
  href: string;
  /** When true, open in a new tab. */
  external?: boolean;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      /** When true, the provider also returns `spark: number[]` and the card draws a sparkline. */
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | {
      kind: 'table';
      title: string;
      data: DataBinding;
      columns: Column[];
      /**
       * Opt into paged-table mode: the UI renders prev/next controls (+ "page X
       * of Y") and re-resolves this panel's provider with `query.page` (1-based)
       * and `query.limit` merged in on top of the panel's own static `data.query`.
       * The provider MUST then return `{ rows, total, page, limit }` instead of
       * a bare `{ rows }` — see {@link DataProvider.resolve}. Omit (or `false`)
       * for the existing bare-rows table, unchanged.
       */
      paged?: boolean;
    }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

/** A named server-side query a panel binds to. */
export interface DataProvider {
  /** Stable name referenced by a panel's `DataBinding.provider`, e.g. 'durable.timeseries'. */
  name: string;
  /**
   * Resolve a panel's data. `query` is the panel's `DataBinding.query` merged with the request query
   * string. Return value shape is per panel kind:
   *  - stat         → `{ value: number; delta?: number; deltaLabel?: string; spark?: number[] }`
   *  - timeseries   → `{ rows: Array<{ label: string } & Record<string, number>> }`
   *  - topN         → `{ items: Array<{ label: string; value: number; id?: string }> }`
   *  - table        → `{ rows: Array<Record<string, unknown>> }`, or — when the
   *                   panel declares `paged: true` — `{ rows, total, page, limit }`
   *                   (`page`/`limit` normally echo the requested `query.page` /
   *                   `query.limit`; `total` is the full, unpaginated row count so
   *                   the UI can compute "page X of Y")
   *  - distribution → `{ buckets: Array<{ label: string; count: number }>; p50?: number; p95?: number; p99?: number }`
   *  - gauge        → `{ value: number; min?: number; max?: number }`
   *  - breakdown    → `{ segments: Array<{ label: string; value: number; color?: string }> }`
   */
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

/** Identity helper for authoring extensions with full type inference. */
export function defineTelescopeExtension(ext: TelescopeExtension): TelescopeExtension {
  return ext;
}
