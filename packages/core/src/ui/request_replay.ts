// packages/core/src/ui/request_replay.ts
//
// Request REPLAY subsystem: re-issue a captured `request` entry against the LOCAL
// server so a developer can reproduce it from the dashboard. Ported from the
// NestJS `nestjs-telescope` `nest/request-replay.ts` (the source of truth) and
// adapted to the Adonis telescope data model and outbound-fetch conventions.
//
// SAFETY POSTURE (read before changing anything here):
//   - DISABLED BY DEFAULT. Replaying re-issues a real request that may MUTATE
//     application state (a captured `POST`/`DELETE` will run again), so the host
//     must opt in via `config/telescope_ui.ts` → `replay: { enabled: true }`.
//     This mirrors the NestJS original, which gates replay behind a default-deny
//     `authorizeAction` mutation gate. A disabled replay never issues a call.
//   - SAME-ORIGIN ONLY. The replay always targets `127.0.0.1:<port>` (the local
//     server) — never an arbitrary URL — so it can't be turned into an SSRF
//     primitive against internal services. Only the captured PATH is reused.
//   - CREDENTIAL STRIPPING. `cookie` / `authorization` / `host` / `content-length`
//     are stripped (see {@link REPLAY_STRIPPED_HEADERS}): a replay must not
//     silently reuse the original caller's credentials or session.
//   - SELF-IDENTIFYING. The replay carries `x-telescope-replay: 1` so the host
//     can recognize/skip it, and the outbound fetch is marked internal so the
//     http-client watcher never records (or recurses on) it.
//   - BOUNDED. A 30s timeout and a 4 KB response-body cap; never throws — a
//     failed call resolves to `status: 0` with an `error`.
//
// REDACTION / CAPTURED-DATA LIMITATION:
//   The Adonis `request` watcher records only `method` + `url` (path, no query
//   string), `status` and timing — it deliberately does NOT capture request
//   headers or the request body (the NestJS original captured `headers`/`payload`
//   and so could replay them; this port has no such fields to replay). A stored
//   entry's `content` is also run through telescope's redaction before
//   persistence, so even where a value exists it may be `[REDACTED]`. We therefore
//   reconstruct only what is safe and present (method + path) and NEVER forward a
//   redacted value upstream — there is nothing to leak.

import type { RequestEntryContent } from '../request_watcher.js';

/** A minimal `fetch`-shaped transport, injectable so tests don't hit the network. */
export type ReplayTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Options for {@link replayRequest} (all injectable for tests). */
export interface ReplayOptions {
  /** Transport used to re-issue the call. Defaults to the global `fetch`,
   *  marked internal so the http-client watcher skips it. */
  transport?: ReplayTransport;
  /** The local server port to target. Defaults to `PORT` env or 3000. */
  port?: number;
  /** Per-call timeout in ms. Default {@link REPLAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Time source; injectable for tests. Default `Date.now`. */
  clock?: { now(): number };
}

/** Outcome of a request replay. */
export interface ReplayResult {
  /** HTTP status of the replayed response, or `0` when the call never completed. */
  status: number;
  /** Wall-clock duration of the replay in ms. */
  durationMs: number;
  /** The response body, capped at {@link REPLAY_BODY_CAP} bytes. */
  body: string;
  /** Present when the replay failed to complete (timeout / network error). */
  error?: string;
}

/** Default per-call timeout for a replay (30s). */
export const REPLAY_TIMEOUT_MS = 30_000;
/** Max bytes of the replayed response body returned (4 KB). */
export const REPLAY_BODY_CAP = 4096;
/** Headers stripped from the replayed request (auth/session/routing leakage). */
export const REPLAY_STRIPPED_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'content-length',
]);

/**
 * Re-issue a captured `request` entry against the LOCAL server (127.0.0.1:<port>)
 * so a developer can reproduce it from the dashboard.
 *
 * The Adonis `request` watcher only captures `method` + `url` (path), so the
 * replay reconstructs exactly that: a GET-style call to the same local path. The
 * call carries `x-telescope-replay: 1`, strips cookie/authorization/host headers
 * (see the SAFETY POSTURE at the top of this file), is bounded by a timeout, and
 * caps the returned body at 4 KB. Never throws — a failed call returns
 * `status: 0` with an `error`.
 */
export async function replayRequest(
  content: RequestEntryContent,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const transport = options.transport ?? defaultTransport;
  const clock = options.clock ?? { now: () => Date.now() };
  const timeoutMs = options.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const port = resolvePort(options.port);

  const path = content.url.startsWith('/') ? content.url : `/${content.url}`;
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = buildReplayHeaders();
  const method = (content.method || 'GET').toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = clock.now();
  try {
    const response = await transport(url, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await response.text();
    return {
      status: response.status,
      durationMs: clock.now() - startedAt,
      body: text.slice(0, REPLAY_BODY_CAP),
    };
  } catch (error: unknown) {
    return {
      status: 0,
      durationMs: clock.now() - startedAt,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the replay request headers. Because the Adonis watcher captures no
 * request headers, there is nothing to copy (and so nothing to leak) — we only
 * force the self-identifying `x-telescope-replay: 1` marker. The
 * {@link REPLAY_STRIPPED_HEADERS} set is documented/exported so the safety
 * contract is explicit and unit-testable even though no source headers exist.
 */
function buildReplayHeaders(): Record<string, string> {
  return { 'x-telescope-replay': '1' };
}

/** Resolve the local server port: explicit override, then `PORT` env, then 3000. */
function resolvePort(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

/** The default transport: the global `fetch`, marked internal so the http-client
 *  watcher never records (or recurses on) the replay call. */
const defaultTransport: ReplayTransport = (url, init) =>
  fetch(url, { ...init, [INTERNAL]: true } as RequestInit);

/** Mirror of `markInternalFetch`'s marker (`@agora/telescope:internalFetch`) so a
 *  replay's outbound fetch is skipped by the http-client watcher without creating
 *  a hard import cycle through the watcher module. */
const INTERNAL = Symbol.for('@agora/telescope:internalFetch');
