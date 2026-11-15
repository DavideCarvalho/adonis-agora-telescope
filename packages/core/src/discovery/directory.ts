/**
 * The map of app name → URL this process resolves `http://<app>/…` with, and the contract other
 * libraries read it through.
 *
 * Two sources, the static one winning: `discovery` in `config/telescope.ts`, and the map the
 * central server keeps from its fleet (apps with a live instance, by the URL their heartbeat
 * carries).
 */

/** One app as the central server describes it. */
export interface DiscoveredApp {
  /** Its base URL (the most recently seen live instance's). */
  url: string;
  /** Live instances right now. `0`: known, but none is up. */
  live: number;
}

/** What the central server sends, and what a tenant saves as its snapshot. */
export interface DiscoveryMap {
  /** Changes whenever the map does. */
  version: string;
  apps: Record<string, DiscoveredApp>;
}

/**
 * The contract on `globalThis[Symbol.for('@adonis-agora/discovery')]`: how any library (the
 * authkit client picking a token audience, the crypto envelope picking a key) learns which app a
 * call goes to, without depending on telescope.
 */
export interface DiscoveryContract {
  /** The base URL of app `name` (case-insensitive), or `undefined` when it is not resolvable. */
  resolve(name: string): string | undefined;
  /** The app an origin (`https://billing.internal`) belongs to, or `undefined`. */
  appOf(origin: string): string | undefined;
  /** Called with no argument whenever the map changes. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
}

export const DISCOVERY_SLOT = Symbol.for('@adonis-agora/discovery');

/** Where a name resolved. */
export type Resolution =
  | { kind: 'url'; url: string }
  /** The central server knows the app, but it has no live instance. `url` is the last seen. */
  | { kind: 'down'; url: string }
  | { kind: 'unknown' };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The map this process resolves names with. */
export class ServiceDirectory implements DiscoveryContract {
  private readonly listeners = new Set<() => void>();
  private registry: Record<string, DiscoveredApp> = {};
  private registryVersion: string | null = null;
  private byOrigin = new Map<string, string>();

  constructor(private readonly staticApps: Record<string, string> = {}) {
    this.reindex();
  }

  /** The version of the central server's map this directory holds, or `null`. */
  get version(): string | null {
    return this.registryVersion;
  }

  /** The central server's map as last received. */
  get map(): DiscoveryMap | null {
    return this.registryVersion === null
      ? null
      : { version: this.registryVersion, apps: { ...this.registry } };
  }

  /** Whether anything can be resolved at all. */
  get empty(): boolean {
    return Object.keys(this.staticApps).length === 0 && Object.keys(this.registry).length === 0;
  }

  /**
   * Replace the central server's map. A name that disappeared keeps its last URL as `down`, so a
   * call to it still has somewhere to go (unless `failFast`).
   */
  update(map: DiscoveryMap): void {
    if (map.version === this.registryVersion) return;
    const next: Record<string, DiscoveredApp> = {};
    for (const [name, app] of Object.entries(map.apps)) {
      if (app !== null && typeof app === 'object' && typeof app.url === 'string') {
        next[name.toLowerCase()] = { url: app.url, live: Math.max(0, Number(app.live) || 0) };
      }
    }
    for (const [name, previous] of Object.entries(this.registry)) {
      if (!(name in next)) next[name] = { url: previous.url, live: 0 };
    }
    this.registry = next;
    this.registryVersion = map.version;
    this.reindex();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** How `name` resolves. */
  lookup(name: string): Resolution {
    const key = name.toLowerCase();
    const fixed = this.staticApps[key];
    if (fixed !== undefined) return { kind: 'url', url: fixed };
    const app = this.registry[key];
    if (app === undefined) return { kind: 'unknown' };
    return app.live > 0 ? { kind: 'url', url: app.url } : { kind: 'down', url: app.url };
  }

  resolve(name: string): string | undefined {
    const found = this.lookup(name);
    return found.kind === 'url' ? found.url : undefined;
  }

  appOf(origin: string): string | undefined {
    const normalized = originOf(origin);
    return normalized === null ? undefined : this.byOrigin.get(normalized);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private reindex(): void {
    const byOrigin = new Map<string, string>();
    for (const [name, app] of Object.entries(this.registry)) {
      const origin = originOf(app.url);
      if (origin !== null) byOrigin.set(origin, name);
    }
    // Static entries win.
    for (const [name, url] of Object.entries(this.staticApps)) {
      const origin = originOf(url);
      if (origin !== null) byOrigin.set(origin, name);
    }
    this.byOrigin = byOrigin;
  }
}

const slot = globalThis as Record<symbol, unknown>;

/** Publish `directory` on the global contract slot (replacing what was there). */
export function publishDirectory(directory: ServiceDirectory): () => void {
  const contract: DiscoveryContract = {
    resolve: (name) => directory.resolve(name),
    appOf: (origin) => directory.appOf(origin),
    subscribe: (listener) => directory.subscribe(listener),
  };
  slot[DISCOVERY_SLOT] = contract;
  return () => {
    if (slot[DISCOVERY_SLOT] === contract) slot[DISCOVERY_SLOT] = undefined;
  };
}
