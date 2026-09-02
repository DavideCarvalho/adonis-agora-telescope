import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { TelescopeClient } from '../client/telescope-client.js';
import type { EntriesQuery, EntrySummary } from '../client/types.js';

/**
 * The {@link TelescopeClient} the hooks call, provided at the app root. A default instance (deriving
 * its API base from the injected global / page location) is used when no provider wraps the tree —
 * tests inject a fake via the exported context.
 */
export const TelescopeClientContext = createContext<TelescopeClient | null>(null);

export function useTelescopeClient(): TelescopeClient {
  const injected = useContext(TelescopeClientContext);
  const fallback = useRef<TelescopeClient | null>(null);
  if (injected) return injected;
  if (fallback.current === null) fallback.current = new TelescopeClient();
  return fallback.current;
}

/** The lifecycle of one async read. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Re-run the fetch (e.g. a manual refresh). */
  reload: () => void;
}

/**
 * One async read, keyed.
 *
 * Backed by TanStack Query (the same thing the apps use), which buys the thing this
 * console needed: two containers asking for the SAME data share one request instead
 * of racing. That is what makes "each container fetches its own data" affordable —
 * without dedup, splitting a page into containers multiplies its requests.
 *
 * `key` MUST start with a name unique to the hook. Keying on the arguments alone
 * would collide `useRetention()` and `useMeta()` — both take none — and silently
 * serve one panel the other's payload.
 */
export function useTelescopeQuery<T>(
  key: readonly unknown[],
  run: () => Promise<T>,
): AsyncState<T> {
  const query = useQuery({
    queryKey: key,
    queryFn: run,
    // The console is a live read surface: a revisit should show current data, not a
    // cached snapshot of what was true when the tab was last open.
    staleTime: 0,
    retry: false,
  });

  const reload = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    // `data` stays defined across a refetch, so a panel keeps its rows on screen
    // while newer ones load instead of blinking back to a skeleton.
    data: query.data ?? null,
    loading: query.isPending,
    error:
      query.error instanceof Error
        ? query.error
        : query.error
          ? new Error(String(query.error))
          : null,
    reload,
  };
}

const queryKey = (q: EntriesQuery) =>
  `${q.type ?? ''}:${q.tag ?? ''}:${q.traceId ?? ''}:${q.search ?? ''}:${q.limit ?? ''}`;

export function useEntries(query: EntriesQuery) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['entries', queryKey(query)], () => client.listEntries(query));
}

/** One page of entries. */
export function useEntriesPage(query: EntriesQuery) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['entries-page', queryKey(query)], () => client.listEntriesPage(query));
}

export function useEntry(id: string) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['entry', id], () => client.getEntry(id));
}

export function useTraceEntries(traceId: string) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['trace-entries', traceId], () => client.entriesByTrace(traceId));
}

export function useTraces(limit = 50) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['traces', limit], () => client.traces(limit));
}

/** Per-route traffic over a window. */
export function useScreens(windowMs: number, kind: string, limit = 100) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['screens', windowMs, kind, limit], () =>
    client.screens(windowMs, kind, limit),
  );
}

/** One page of traces. `page` is 1-based and owned by the caller. */
export function useTracesPage(limit: number, page: number) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['traces-page', limit, page], () => client.tracesPage(limit, page));
}

export function useWaterfall(traceId: string) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['waterfall', traceId], () => client.waterfall(traceId));
}

export function useNPlusOne(traceId: string) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['n-plus-one', traceId], () => client.nPlusOne(traceId));
}

export function usePulse(windowMs: number, topN?: number) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['pulse', windowMs, topN ?? null], () => client.pulse(windowMs, topN));
}

export function useMetricsStats(type: string, windowMs: number, topExceptions?: number) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['metrics-stats', type, windowMs, topExceptions ?? null], () =>
    client.metricsStats(type, windowMs, undefined, topExceptions),
  );
}

/** Throughput timeseries (total + per-type breakdown) — backs the Overview/Pulse charts. */
export function useTimeseries(windowMs: number, buckets?: number, type?: string) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['timeseries', windowMs, buckets ?? null, type ?? null], () =>
    client.metricsTimeseries(windowMs, buckets, type),
  );
}

export function useRetention() {
  const client = useTelescopeClient();
  return useTelescopeQuery(['retention'], () => client.retention());
}

/**
 * Whether a watcher is running, as far as the server told us.
 *
 * Three-valued on purpose. `null` means "the server did not say" (an older core, or
 * `/meta` still loading), and a panel must NOT claim a watcher is off in that case —
 * replacing one confident wrong answer with another is not an improvement.
 */
export function useWatcherEnabled(name: string): boolean | null {
  const { data } = useMeta();
  if (!data || data.watchers === undefined) return null;
  return data.watchers.includes(name);
}

export function useMeta() {
  const client = useTelescopeClient();
  return useTelescopeQuery(['meta'], () => client.meta());
}

// ── CPU profiling ──────────────────────────────────────────────────────────

export function useProfilerStatus() {
  const client = useTelescopeClient();
  return useTelescopeQuery(['profiler-status'], () => client.profilerStatus());
}

export function useProfiles(limit = 100) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['profiles', limit], () => client.profiles(limit));
}

export function useProfile(id: string | null) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['profile', id], () =>
    id === null ? Promise.resolve(null) : client.profile(id),
  );
}

/** Mutation-style hook: `arm(count, label?)` returns the `ArmOutcome` (never throws). */
export function useArmProfile() {
  const client = useTelescopeClient();
  return useCallback((count: number, label?: string) => client.armProfile(count, label), [client]);
}

// ── live queue manager ───────────────────────────────────────────────────

export function useLiveQueues() {
  const client = useTelescopeClient();
  return useTelescopeQuery(['live-queues'], () => client.liveQueues());
}

export function useQueueJob(queue: string | null, id: string | null) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['queue-job', queue, id], () =>
    queue === null || id === null ? Promise.resolve(null) : client.queueJob(queue, id),
  );
}

// ── live schedules ───────────────────────────────────────────────────────

export function useLiveSchedules() {
  const client = useTelescopeClient();
  return useTelescopeQuery(['live-schedules'], () => client.liveSchedules());
}

const extQueryKey = (query: Record<string, string> | undefined) =>
  query
    ? Object.entries(query)
        .sort(([a], [b]) => a.localeCompare(b))
        .join('&')
    : '';

export function useExtensionData<T>(ext: string, provider: string, query?: Record<string, string>) {
  const client = useTelescopeClient();
  return useTelescopeQuery(['ext-data', ext, provider, extQueryKey(query)], () =>
    client.extData<T>(ext, provider, query),
  );
}

// ── live tail (SSE) ────────────────────────────────────────────────────────

/**
 * Parse a raw SSE `entry` frame's `data` payload into an {@link EntrySummary}. Pure + defensive:
 * returns `null` for non-JSON, non-objects, or a payload missing the `id`/`type` a summary must
 * carry — so a heartbeat or malformed frame never crashes the tail. Exported for unit testing.
 */
export function parseEntryFrame(data: string): EntrySummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.type !== 'string') return null;
  return record as unknown as EntrySummary;
}

/** A minimal `EventSource` shape so the hook is injectable/testable without the browser global. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export const EventSourceFactoryContext = createContext<EventSourceFactory | null>(null);

export type LiveStatus = 'connecting' | 'live' | 'error' | 'unsupported' | 'idle';

/**
 * Subscribe to the telescope SSE live stream (`<base>/stream`) while `enabled`, buffering the newest
 * {@link EntrySummary} frames (capped at `cap`, newest-first). Tears the connection down on disable
 * or unmount. Falls back to `'unsupported'` when no `EventSource` is available (SSR / jsdom without
 * an injected factory), so a live-tail toggle degrades cleanly rather than throwing.
 */
export function useLiveTail(enabled: boolean, cap = 100) {
  const client = useTelescopeClient();
  const injectedFactory = useContext(EventSourceFactoryContext);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [status, setStatus] = useState<LiveStatus>('idle');

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    const factory =
      injectedFactory ??
      (typeof EventSource !== 'undefined'
        ? (url: string) => new EventSource(url) as unknown as EventSourceLike
        : null);
    if (factory === null) {
      setStatus('unsupported');
      return;
    }

    setStatus('connecting');
    const source = factory(client.streamUrl());
    source.addEventListener('open', () => setStatus('live'));
    source.addEventListener('entry', (event) => {
      const summary = parseEntryFrame(event.data);
      if (summary === null) return;
      setStatus('live');
      setEntries((prev) => [summary, ...prev].slice(0, cap));
    });
    source.onerror = () => setStatus('error');

    return () => source.close();
  }, [enabled, client, injectedFactory, cap]);

  const clear = useCallback(() => setEntries([]), []);
  return { entries, status, clear };
}
