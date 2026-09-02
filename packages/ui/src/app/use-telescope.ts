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
 * A tiny dependency-free `useQuery`: runs `run` on mount and whenever `deps` change, tracks
 * loading/error, and ignores a resolved response from a superseded call (last-write-wins) so a fast
 * filter change never flashes stale data. No caching — the console is a live read surface.
 */
export function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the intentional trigger set.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    runRef
      .current()
      .then((value) => {
        if (live) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}

const queryKey = (q: EntriesQuery) =>
  `${q.type ?? ''}:${q.tag ?? ''}:${q.traceId ?? ''}:${q.search ?? ''}:${q.limit ?? ''}`;

export function useEntries(query: EntriesQuery) {
  const client = useTelescopeClient();
  return useAsync(() => client.listEntries(query), [client, queryKey(query)]);
}

/** One page of entries. */
export function useEntriesPage(query: EntriesQuery) {
  const client = useTelescopeClient();
  return useAsync(() => client.listEntriesPage(query), [client, queryKey(query)]);
}

export function useEntry(id: string) {
  const client = useTelescopeClient();
  return useAsync(() => client.getEntry(id), [client, id]);
}

export function useTraceEntries(traceId: string) {
  const client = useTelescopeClient();
  return useAsync(() => client.entriesByTrace(traceId), [client, traceId]);
}

export function useTraces(limit = 50) {
  const client = useTelescopeClient();
  return useAsync(() => client.traces(limit), [client, limit]);
}

/** One page of traces. `page` is 1-based and owned by the caller. */
export function useTracesPage(limit: number, page: number) {
  const client = useTelescopeClient();
  return useAsync(() => client.tracesPage(limit, page), [client, limit, page]);
}

export function useWaterfall(traceId: string) {
  const client = useTelescopeClient();
  return useAsync(() => client.waterfall(traceId), [client, traceId]);
}

export function useNPlusOne(traceId: string) {
  const client = useTelescopeClient();
  return useAsync(() => client.nPlusOne(traceId), [client, traceId]);
}

export function usePulse(windowMs: number, topN?: number) {
  const client = useTelescopeClient();
  return useAsync(() => client.pulse(windowMs, topN), [client, windowMs, topN]);
}

export function useMetricsStats(type: string, windowMs: number, topExceptions?: number) {
  const client = useTelescopeClient();
  return useAsync(
    () => client.metricsStats(type, windowMs, undefined, topExceptions),
    [client, type, windowMs, topExceptions],
  );
}

/** Throughput timeseries (total + per-type breakdown) — backs the Overview/Pulse charts. */
export function useTimeseries(windowMs: number, buckets?: number, type?: string) {
  const client = useTelescopeClient();
  return useAsync(
    () => client.metricsTimeseries(windowMs, buckets, type),
    [client, windowMs, buckets, type],
  );
}

export function useRetention() {
  const client = useTelescopeClient();
  return useAsync(() => client.retention(), [client]);
}

export function useMeta() {
  const client = useTelescopeClient();
  return useAsync(() => client.meta(), [client]);
}

// ── CPU profiling ──────────────────────────────────────────────────────────

export function useProfilerStatus() {
  const client = useTelescopeClient();
  return useAsync(() => client.profilerStatus(), [client]);
}

export function useProfiles(limit = 100) {
  const client = useTelescopeClient();
  return useAsync(() => client.profiles(limit), [client, limit]);
}

export function useProfile(id: string | null) {
  const client = useTelescopeClient();
  return useAsync(() => (id === null ? Promise.resolve(null) : client.profile(id)), [client, id]);
}

/** Mutation-style hook: `arm(count, label?)` returns the `ArmOutcome` (never throws). */
export function useArmProfile() {
  const client = useTelescopeClient();
  return useCallback((count: number, label?: string) => client.armProfile(count, label), [client]);
}

// ── live queue manager ───────────────────────────────────────────────────

export function useLiveQueues() {
  const client = useTelescopeClient();
  return useAsync(() => client.liveQueues(), [client]);
}

export function useQueueJob(queue: string | null, id: string | null) {
  const client = useTelescopeClient();
  return useAsync(
    () => (queue === null || id === null ? Promise.resolve(null) : client.queueJob(queue, id)),
    [client, queue, id],
  );
}

// ── live schedules ───────────────────────────────────────────────────────

export function useLiveSchedules() {
  const client = useTelescopeClient();
  return useAsync(() => client.liveSchedules(), [client]);
}

const extQueryKey = (query: Record<string, string> | undefined) =>
  query
    ? Object.entries(query)
        .sort(([a], [b]) => a.localeCompare(b))
        .join('&')
    : '';

export function useExtensionData<T>(ext: string, provider: string, query?: Record<string, string>) {
  const client = useTelescopeClient();
  return useAsync(
    () => client.extData<T>(ext, provider, query),
    [client, ext, provider, extQueryKey(query)],
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
