import { runAsTelescopeWork } from '../../self_scope.js';
import { serverPrefix } from '../config.js';
import { isServerUrlInput, ServerUrl, type ServerUrlInput } from '../server_url.js';
import { APP_HEADER } from '../wire.js';
import {
  errorMessage,
  type OutgoingBatch,
  type SendOutcome,
  type TelescopeTransport,
  type TenantChannel,
} from './types.js';

/** Options of `transports.http()`. */
export interface HttpTransportOptions {
  /**
   * The control plane: its origin (`https://telescope.example.com`, the default path is added)
   * or the full prefix (`https://telescope.example.com/_telescope/v1`). Or a function resolving
   * it when the first batch is sent, such as `controlPlaneUrl({ issuer, resource: 'urn:agora:telescope' })`:
   * looked up again (its `refresh()`) when the server cannot be reached or answers 404.
   */
  url: ServerUrlInput;
  /** Replaces the global `fetch` (a proxy, mTLS, request signing, tests). */
  fetch?: typeof fetch;
  /** Per-request timeout. Default `tenant.buffer.timeoutMs` (10,000 ms). */
  timeoutMs?: number;
}

type Attempt = { kind: 'status'; status: number } | { kind: 'error'; error: unknown };

/** `POST <prefix>/ingest`, one request per batch. */
export class HttpTenantChannel implements TenantChannel {
  private readonly server: ServerUrl;
  private readonly doFetch: typeof fetch;

  constructor(
    url: ServerUrlInput | ServerUrl,
    private readonly timeoutMs: number,
    doFetch?: typeof fetch,
  ) {
    this.server = url instanceof ServerUrl ? url : new ServerUrl(url);
    // A plain string is checked now, as before.
    if (!this.server.lazy) serverPrefix(this.server.current as string);
    this.doFetch = doFetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    let url: string;
    try {
      url = await this.server.get();
    } catch (error) {
      return {
        kind: 'failed',
        message: `the server URL cannot be resolved: ${errorMessage(error)}`,
      };
    }
    let attempt = await this.post(url, batch);
    // The server moved (or its URL went stale): look it up again and retry once at the new URL.
    if (this.server.lazy && (attempt.kind === 'error' || attempt.status === 404)) {
      const fresh = await this.server.refresh();
      if (fresh !== null && fresh !== url) attempt = await this.post(fresh, batch);
    }
    if (attempt.kind === 'error') return { kind: 'failed', message: errorMessage(attempt.error) };
    const status = attempt.status;
    if (status >= 200 && status < 300) return { kind: 'ok' };
    if (status === 413 && batch.entries > 1) return { kind: 'too-large' };
    if (status === 400 || status === 413 || status === 422) {
      return {
        kind: 'rejected',
        message: `the server refused ${batch.entries} entries (${status})`,
      };
    }
    return {
      kind: 'failed',
      message: `the server answered ${status}`,
      auth: status === 401 || status === 403,
    };
  }

  private async post(url: string, batch: OutgoingBatch): Promise<Attempt> {
    try {
      const response = await runAsTelescopeWork(() =>
        this.doFetch(`${serverPrefix(url)}/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${batch.token}`,
            [APP_HEADER]: batch.partition,
          },
          body: batch.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
      );
      await response.body?.cancel().catch(() => {});
      return { kind: 'status', status: response.status };
    } catch (error) {
      return { kind: 'error', error };
    }
  }
}

const INVALID_URL =
  '[@adonis-agora/telescope] transports.http() needs an absolute http(s) `url`, or a function returning one';

/** The HTTP driver: the tenant posts each batch; the control plane's ingest routes take it. */
export function httpTransport(options: HttpTransportOptions): TelescopeTransport & {
  readonly options: HttpTransportOptions;
  /** The control plane's URL, resolved once and shared by the channel, status and doctor. */
  readonly server: ServerUrl;
} {
  if (options === null || typeof options !== 'object' || !isServerUrlInput(options.url)) {
    throw new Error(INVALID_URL);
  }
  if (typeof options.url === 'string') {
    try {
      serverPrefix(options.url);
    } catch {
      throw new Error(INVALID_URL);
    }
  }
  const server = new ServerUrl(options.url);
  const describe = () => {
    const url = server.current;
    return url !== null ? `http ${serverPrefix(url)}` : 'http (URL resolved on first send)';
  };
  return {
    driver: 'http',
    options,
    server,
    describe,
    tenant: async (ctx) =>
      new HttpTenantChannel(server, options.timeoutMs ?? ctx.timeoutMs ?? 10_000, options.fetch),
    controlPlane: async () => null,
    ping: async () =>
      `The control plane's ingest routes are at ${serverPrefix(await server.get())}.`,
  };
}
