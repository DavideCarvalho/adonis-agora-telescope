import { durationToMs } from './alerts/parse_duration.js';
import {
  type ClientErrorsConfig,
  type ResolvedClientErrorsConfig,
  resolveClientErrors,
} from './client_errors/config.js';
import type { TelescopeExtension } from './extension/types.js';
import { PULSE_CARDS, type PulseCardName } from './metrics/pulse.js';
import type { RedactBounds } from './redaction/redact.js';
import type { RequestCaptureOptions } from './request_watcher.js';
import { type SamplingConfig, resolveSampling } from './sampling/sampling.js';
import type { TelescopeStore } from './store.js';
import { type StoreProvider, storage } from './stores/factory.js';
import type { LogLevel, LogsWatcherOptions } from './watchers/logs_watcher.js';

/** Default retention age for the pruner when `prune.after` is omitted. */
const DEFAULT_PRUNE_AFTER = '24h';
/** Default interval (ms) between scheduled prune cycles. */
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
/** Default p99 event-loop lag (ms) at which the overload guard sheds capture. */
const DEFAULT_MAX_EVENT_LOOP_LAG_MS = 200;
/** Default startup grace (ms) the overload guard discards before it can pause. */
const DEFAULT_STARTUP_GRACE_MS = 5_000;

/**
 * Sensitive-data redaction applied to EVERY entry's content before it is
 * persisted. Defaults are on; supply `keys` to extend the masked set or
 * `enabled: false` to opt out entirely.
 */
export interface RedactConfig {
  /**
   * Master switch for redaction. When `false`, content is persisted verbatim.
   * Default `true`.
   */
  enabled?: boolean;
  /**
   * Extra sensitive key names to mask, merged with the built-in defaults
   * (`authorization`, `cookie`, `password`, `token`, `api_key`, `secret`, …).
   * Matched case-insensitively at any depth.
   */
  keys?: string[];
  /**
   * Per-entry-type overrides of the NUMERIC redaction bounds (e.g. a bigger
   * `maxContentBytes` for `exception`/`client_exception`, whose stacks are
   * legitimately many KB), keyed by entry `type`. Lets rare high-value entries
   * carry a larger budget without loosening the global OOM guard on high-volume
   * request/query/cache entries. Masking (`keys`) stays global. See
   * {@link RedactBounds}.
   */
  perType?: Record<string, RedactBounds>;
}

/** The set of watchers this headless slice ships. */
export type WatcherName = 'request' | 'diagnostics' | 'logs';

/**
 * The shape of `config/telescope.ts`. Everything is optional with sane defaults:
 * the in-memory store, both shipped watchers enabled, a 1000-entry cap.
 */
export interface TelescopeConfig {
  /**
   * Master switch. When `false`, the provider records nothing and both watchers
   * stay dormant (zero overhead). Default `true`.
   */
  enabled?: boolean;

  /**
   * Which store backs telescope. Three forms are accepted:
   *
   * - a **key of {@link stores}** (the idiomatic form) — e.g. `'memory'` or `'lucid'`,
   *   selecting one of the drivers built with the {@link storage} factory;
   * - the literal `'memory'` — the built-in ring buffer, even with no `stores` map;
   * - a {@link TelescopeStore} instance — for a custom backend wired by hand.
   *
   * Default `'memory'`.
   */
  store?: string | TelescopeStore;

  /**
   * Named store drivers, built with the {@link storage} factory. The active one is
   * selected by {@link store}. Each factory returns a lazy thunk; its peer dependency
   * (`@adonisjs/lucid` for `lucid`) is only imported when that driver is the active one.
   */
  stores?: Record<string, StoreProvider>;

  /**
   * Hard cap on retained entries for the in-memory store when selected by the bare
   * `store: 'memory'` shorthand (no `stores` map). Oldest entries are evicted past
   * this. Default 1000. Prefer `storage.memory({ limit })` in the `stores` map.
   */
  maxEntries?: number;

  /**
   * Which watchers are active. Omit a name to disable it. Defaults to both
   * (`request` + `diagnostics`).
   */
  watchers?: WatcherName[];

  /**
   * Fine-tunes the generic `diagnostics` watcher (only meaningful while it is
   * active). Mute noisy channels via {@link DiagnosticsConfig.exclude}. Defaults
   * are all-off (record every diagnostics event).
   */
  diagnostics?: DiagnosticsConfig;

  /**
   * Fine-tunes the `logs` watcher (only meaningful while it is active), which
   * tees the AdonisJS `Logger` level methods and records each log as a `log`
   * entry. `minLevel` raises the floor (e.g. `'warn'` drops debug/info) and
   * `tags` are appended to every recorded log entry. Defaults record everything.
   */
  logs?: LogsWatcherOptions;

  /**
   * Opt-in request BODY capture, gated so a huge or binary body is never walked
   * by the synchronous redaction pass. When set (even to `{}` for defaults), the
   * request watcher captures the body through content-type / size / predicate
   * gates; a gated-out body becomes a marker string. OFF by default (no `body`
   * field on request entries). See {@link RequestCaptureOptions}.
   */
  requestCapture?: RequestCaptureOptions;

  /**
   * Extensions contributed by sibling libs (e.g. `@adonis-agora/durable-telescope`) — each adds navigable
   * entry types, dashboard pages, and the data providers those pages bind to. Default none.
   */
  extensions?: TelescopeExtension[];

  /**
   * Sensitive-data redaction applied to every entry's content before persistence.
   * Enabled by default with a built-in set of sensitive keys. Set
   * `redact: { enabled: false }` to opt out, or `redact: { keys: [...] }` to mask
   * additional keys.
   */
  redact?: RedactConfig;

  /**
   * Tail-sampling applied on the WRITE path: a dropped entry is never persisted.
   * Three forms are accepted:
   *
   * - a **bare number** (0–1) — a uniform keep-rate applied to every entry type
   *   via the reserved `default` key (e.g. `sampling: 0.1` keeps 10%);
   * - a **{@link SamplingConfig}** — per-type rates, each either a bare rate or a
   *   `{ rate, keepErrors?, keepSlowMs? }` rule (tail-sampling: keep a fraction
   *   but always retain errors / slow entries), with a reserved `default` rule;
   * - omitted — record everything (rate 1), so behavior is unchanged when unset.
   */
  sampling?: number | SamplingConfig;

  /**
   * N+1 query-loop detection thresholds (read-only analysis over stored entries).
   * `threshold` is the minimum repetitions of one query template within a trace
   * to flag a loop (default 3). Set `enabled: false` to disable detection.
   */
  nPlusOne?: NPlusOneConfig;

  /**
   * Pulse — the aggregated "at a glance" health rollup (slowest entries, error
   * rate, throughput, top exceptions, cache hit ratio, slow route/outgoing/job
   * hotspots, N+1, load-by-user) computed on demand from stored entries. Enabled
   * by default over a trailing 1h window with every card; set `enabled: false` to
   * disable the `<path>/api/metrics/pulse` route, tune `windowMs`, or restrict
   * `cards`. See {@link PulseConfig}.
   */
  pulse?: PulseConfig;

  /**
   * Live SSE streaming of newly-stored entries to the dashboard. When enabled
   * (the default), the write path publishes each persisted entry — already
   * redacted and post-sampling — to an in-process bus the `<path>/api/stream`
   * route streams over Server-Sent Events. Zero overhead while no client is
   * connected. Set `stream: { enabled: false }` to turn it off entirely.
   */
  stream?: StreamConfig;

  /**
   * Background retention: a pruner deletes stale entries on a timer so the store
   * never grows without bound. OFF unless a `prune` block is supplied — omit it
   * and the store is only bounded by its own cap (the memory ring buffer's
   * `maxEntries`). Supply `prune: { after: '24h' }` to delete entries older than a
   * cutoff, `keepLast` to also cap by count, and `intervalMs` to tune the cadence.
   * See {@link PruneConfig}.
   */
  prune?: PruneConfig;

  /**
   * Overload protection: a guard samples the process event-loop delay and PAUSES
   * ingestion when the p99 lag crosses a threshold, resuming once it recovers — so
   * telescope can never amplify an incident. ON by default at a 200ms threshold;
   * set `overload: false`-style `{ enabled: false }` to disable it. See
   * {@link OverloadConfig}.
   */
  overload?: OverloadConfig;

  /**
   * Public front-end error ingestion: a `POST` endpoint browsers report
   * client-side errors to, recorded as `client_exception` entries through the
   * normal pipeline (family-hash, `failed`/`client`/`user:<id>` tags, sampling,
   * prune, dashboard). DISABLED by default — a public, unauthenticated surface is
   * opt-in; when off, no route is registered at all. Protected by a body byte
   * cap, an in-memory per-IP token bucket, an optional `authorize` hook, and the
   * overload guard's shed flag. See {@link ClientErrorsConfig}.
   */
  clientErrors?: ClientErrorsConfig;
}

/** Diagnostics-watcher configuration (see {@link TelescopeConfig.diagnostics}). */
export interface DiagnosticsConfig {
  /**
   * `lib:event` keys to skip recording — the exact label the "Busiest events"
   * panel shows (e.g. `'media:upload.progress'`). Mute high-frequency channels
   * that would otherwise flood the timeline; the events stay live on their
   * diagnostics channel for other subscribers (OTel, custom watchers). Default `[]`.
   */
  exclude?: string[];
  /**
   * Record events whose `lib:event` key is claimed by a lib-specific watcher
   * (via `@adonis-agora/diagnostics`'s `claimDiagnostics`), instead of skipping
   * them by default. Default `false` — a claimed event is already recorded as a
   * typed entry by the claiming lib, so recording it again here would duplicate
   * it. `exclude` still mutes noisy events regardless of claim status.
   */
  recordClaimed?: boolean;
}

/** Background-pruner configuration (see {@link TelescopeConfig.prune}). */
export interface PruneConfig {
  /**
   * Master switch. Defaults to `true` whenever a `prune` block is present, so
   * supplying `prune: { after: '24h' }` is enough to arm it; set `enabled: false`
   * to keep the block for reference while disabling the timer.
   */
  enabled?: boolean;
  /**
   * Age cutoff: entries older than this are deleted each cycle. A raw ms number or
   * a `<int><ms|s|m|h|d>` string (e.g. `'24h'`, `'7d'`). An unparseable value is a
   * boot error, not a silent no-op. Default `'24h'`.
   */
  after?: number | string;
  /**
   * Count-based retention: keep at most the newest N of the entries a cycle would
   * otherwise delete (the store's `keepLast`). Combine with `after` to bound by
   * both age and count. Default unset (pure age-based pruning).
   */
  keepLast?: number;
  /** How often a scheduled prune cycle runs, in ms. Default 60000. */
  intervalMs?: number;
}

/** Overload-guard configuration (see {@link TelescopeConfig.overload}). */
export interface OverloadConfig {
  /** Master switch for overload protection. Default `true`. */
  enabled?: boolean;
  /** p99 event-loop lag (ms) at or above which capture pauses. Default 200. */
  maxEventLoopLagMs?: number;
  /**
   * Startup grace (ms): leading sample windows discarded before the guard can
   * pause, so the synchronous boot stall never trips it on a transient. Default
   * 5000. Never negative.
   */
  startupGraceMs?: number;
}

/** N+1 detection configuration (see {@link TelescopeConfig.nPlusOne}). */
export interface NPlusOneConfig {
  /** Master switch for N+1 detection. Default `true`. */
  enabled?: boolean;
  /** Minimum repetitions of one query template within a trace to flag a loop. Default 3. */
  threshold?: number;
}

/** Pulse rollup configuration (see {@link TelescopeConfig.pulse}). */
export interface PulseConfig {
  /** Master switch for the pulse rollup + its route. Default `true`. */
  enabled?: boolean;
  /** Trailing window (ms) the rollup aggregates over. Default 3_600_000 (1h). */
  windowMs?: number;
  /** How many rows each top-N list returns. Default 5. */
  topN?: number;
  /** Throughput bucket count (clamped 1–500). Default 60. */
  buckets?: number;
  /** Min p99 (ms) for a route/outgoing family to count as a slow hotspot. Default 1000. */
  slowRouteMs?: number;
  /**
   * Which cards to compute. Omit for all. `counts` and the window meta are always
   * present; every other card can be toggled off to trim the payload.
   */
  cards?: PulseCardName[];
}

/** Live-stream configuration (see {@link TelescopeConfig.stream}). */
export interface StreamConfig {
  /** Master switch for the SSE live-stream of entries. Default `true`. */
  enabled?: boolean;
}

/** The fully-resolved config the provider acts on (no optionals). */
export interface ResolvedTelescopeConfig {
  enabled: boolean;
  store: string | TelescopeStore;
  stores: Record<string, StoreProvider>;
  maxEntries: number;
  watchers: Set<WatcherName>;
  /** Resolved diagnostics-watcher settings (always present; defaults record everything). */
  diagnostics: { exclude: string[]; recordClaimed: boolean };
  /** Resolved logs-watcher settings (always present; defaults record everything). */
  logs: { minLevel: LogLevel; tags: string[] };
  /** Opt-in request body-capture gates, or `null` when body capture is off (default). */
  requestCapture: RequestCaptureOptions | null;
  extensions: TelescopeExtension[];
  redact: { enabled: boolean; keys: string[]; perType: Record<string, RedactBounds> };
  /** Normalized per-type sampling config; empty `{}` means record everything. */
  sampling: SamplingConfig;
  /** Resolved N+1 detection settings. */
  nPlusOne: { enabled: boolean; threshold: number };
  /** Resolved pulse-rollup settings. */
  pulse: {
    enabled: boolean;
    windowMs: number;
    topN: number;
    buckets: number;
    slowRouteMs: number;
    cards: PulseCardName[];
  };
  /** Resolved live-stream settings. */
  stream: { enabled: boolean };
  /**
   * Resolved pruner settings. `afterMs`/`intervalMs` are always present (defaulted)
   * so the pruner can act on them directly; it only runs when `enabled` is `true`,
   * which is `false` unless a `prune` block was supplied.
   */
  prune: {
    enabled: boolean;
    afterMs: number;
    keepLast?: number;
    intervalMs: number;
  };
  /** Resolved overload-guard settings (always present; `enabled` defaults `true`). */
  overload: {
    enabled: boolean;
    maxEventLoopLagMs: number;
    startupGraceMs: number;
  };
  /** Resolved client-error ingestion settings (always present; `enabled` defaults `false`). */
  clientErrors: ResolvedClientErrorsConfig;
}

/**
 * Identity helper giving `config/telescope.ts` full type-checking. Mirrors the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig, storage } from '@adonis-agora/telescope'
 *
 * export default defineConfig({
 *   store: 'memory',
 *   stores: {
 *     memory: storage.memory({ limit: 1000 }),
 *     lucid: storage.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 */
export function defineConfig(config: TelescopeConfig): TelescopeConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeConfig = {}): ResolvedTelescopeConfig {
  const watchers = config.watchers ?? ['request', 'diagnostics'];
  return {
    enabled: config.enabled ?? true,
    store: config.store ?? 'memory',
    stores: config.stores ?? {},
    maxEntries: config.maxEntries ?? 1000,
    watchers: new Set(watchers),
    diagnostics: {
      exclude: config.diagnostics?.exclude ?? [],
      recordClaimed: config.diagnostics?.recordClaimed ?? false,
    },
    logs: {
      minLevel: config.logs?.minLevel ?? 'trace',
      tags: [...(config.logs?.tags ?? [])],
    },
    requestCapture: config.requestCapture ?? null,
    extensions: config.extensions ?? [],
    redact: {
      enabled: config.redact?.enabled ?? true,
      keys: config.redact?.keys ?? [],
      perType: config.redact?.perType ?? {},
    },
    sampling: resolveSampling(config.sampling),
    nPlusOne: {
      enabled: config.nPlusOne?.enabled ?? true,
      threshold: config.nPlusOne?.threshold ?? 3,
    },
    pulse: {
      enabled: config.pulse?.enabled ?? true,
      windowMs: config.pulse?.windowMs ?? 3_600_000,
      topN: config.pulse?.topN ?? 5,
      buckets: config.pulse?.buckets ?? 60,
      slowRouteMs: config.pulse?.slowRouteMs ?? 1000,
      cards: config.pulse?.cards ?? [...PULSE_CARDS],
    },
    stream: {
      enabled: config.stream?.enabled ?? true,
    },
    prune: resolvePrune(config.prune),
    overload: {
      enabled: config.overload?.enabled ?? true,
      maxEventLoopLagMs: config.overload?.maxEventLoopLagMs ?? DEFAULT_MAX_EVENT_LOOP_LAG_MS,
      startupGraceMs: Math.max(0, config.overload?.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS),
    },
    clientErrors: resolveClientErrors(config.clientErrors),
  };
}

/**
 * Resolve the (optional) pruner block. Absent ⇒ disabled. Present ⇒ enabled
 * unless `enabled: false`, with `after`/`intervalMs` defaulted. `after` is parsed
 * here so a bad duration surfaces at boot (config resolution) rather than as a
 * silent runtime skip.
 */
function resolvePrune(prune: TelescopeConfig['prune']): ResolvedTelescopeConfig['prune'] {
  const enabled = prune ? (prune.enabled ?? true) : false;
  return {
    enabled,
    afterMs: durationToMs(prune?.after ?? DEFAULT_PRUNE_AFTER),
    ...(prune?.keepLast !== undefined ? { keepLast: prune.keepLast } : {}),
    intervalMs: prune?.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
  };
}

export { storage };
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
