/**
 * A control plane URL resolved when it is first needed: `controlPlaneUrl({ issuer, resource })`
 * from `@adonis-agora/authkit-client`, or any `() => Promise<string>`. `refresh()`, when present,
 * looks the URL up again (the server moved); without it the function itself is called again.
 */
export interface LazyServerUrl {
  (): Promise<string>;
  refresh?: () => Promise<string>;
}

/** `tenant.url` / `transports.http({ url })`: the URL, or a function that resolves it. */
export type ServerUrlInput = string | LazyServerUrl;

/** Whether `url` is an absolute http(s) URL. */
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** A string `isHttpUrl` accepts, or a function (resolved later). */
export function isServerUrlInput(url: unknown): url is ServerUrlInput {
  return typeof url === 'function' || isHttpUrl(url);
}

const PREFIX = '[@adonis-agora/telescope]';

/**
 * Resolves a {@link ServerUrlInput} once and caches it: a string as is, a function on the first
 * {@link get} (a failure is not cached, so the next call tries again). {@link refresh} resolves
 * it again after a connection error or a 404.
 */
export class ServerUrl {
  private value: string | null;
  private pending: Promise<string> | null = null;

  constructor(private readonly source: ServerUrlInput) {
    this.value = typeof source === 'string' ? source : null;
  }

  /** Whether the URL comes from a function (it can be refreshed). */
  get lazy(): boolean {
    return typeof this.source === 'function';
  }

  /** The URL when already resolved, else `null`. */
  get current(): string | null {
    return this.value;
  }

  /** The URL, resolving it on first use. */
  get(): Promise<string> {
    if (this.value !== null) return Promise.resolve(this.value);
    return this.resolve(() => (this.source as LazyServerUrl)());
  }

  /**
   * Resolve the URL again (with the function's `refresh()` when it has one). Returns the new URL,
   * or `null` for a plain string or when the lookup fails (the cached URL is kept).
   */
  async refresh(): Promise<string | null> {
    if (typeof this.source === 'string') return null;
    const source = this.source;
    try {
      return await this.resolve(() =>
        typeof source.refresh === 'function' ? source.refresh() : source(),
      );
    } catch {
      return null;
    }
  }

  private resolve(lookup: () => Promise<string>): Promise<string> {
    if (this.pending !== null) return this.pending;
    const pending = (async () => {
      const url = await lookup();
      if (!isHttpUrl(url)) {
        throw new Error(
          `${PREFIX} the tenant URL function returned ${JSON.stringify(url)}, not an absolute http(s) URL`,
        );
      }
      this.value = url;
      return url;
    })();
    this.pending = pending;
    const clear = () => {
      if (this.pending === pending) this.pending = null;
    };
    pending.then(clear, clear);
    return pending;
  }
}
