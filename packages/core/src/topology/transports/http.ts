import { runAsTelescopeWork } from '../../self_scope.js';
import { serverPrefix } from '../config.js';
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
   * or the full prefix (`https://telescope.example.com/_telescope/v1`).
   */
  url: string;
  /** Replaces the global `fetch` (a proxy, mTLS, request signing, tests). */
  fetch?: typeof fetch;
  /** Per-request timeout. Default `tenant.buffer.timeoutMs` (10,000 ms). */
  timeoutMs?: number;
}

/** `POST <prefix>/ingest`, one request per batch. */
export class HttpTenantChannel implements TenantChannel {
  private readonly prefix: string;
  private readonly doFetch: typeof fetch;

  constructor(
    url: string,
    private readonly timeoutMs: number,
    doFetch?: typeof fetch,
  ) {
    this.prefix = serverPrefix(url);
    this.doFetch = doFetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    let status: number;
    try {
      const response = await runAsTelescopeWork(() =>
        this.doFetch(`${this.prefix}/ingest`, {
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
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
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
}

/** The HTTP driver: the tenant posts each batch; the control plane's ingest routes take it. */
export function httpTransport(options: HttpTransportOptions): TelescopeTransport & {
  readonly options: HttpTransportOptions;
} {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.url !== 'string' ||
    !/^https?:\/\//.test(options.url)
  ) {
    throw new Error('[@adonis-agora/telescope] transports.http() needs an absolute http(s) `url`');
  }
  try {
    serverPrefix(options.url);
  } catch {
    throw new Error('[@adonis-agora/telescope] transports.http() needs an absolute http(s) `url`');
  }
  return {
    driver: 'http',
    options,
    describe: () => `http ${serverPrefix(options.url)}`,
    tenant: async (ctx) =>
      new HttpTenantChannel(
        options.url,
        options.timeoutMs ?? ctx.timeoutMs ?? 10_000,
        options.fetch,
      ),
    controlPlane: async () => null,
    ping: async () => `The control plane's ingest routes are at ${serverPrefix(options.url)}.`,
  };
}
