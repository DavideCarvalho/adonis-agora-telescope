import { createHash } from 'node:crypto';
import { type InstanceRecord, instanceStatus } from '../fleet/derive.js';
import type { DiscoveredApp, DiscoveryMap } from './directory.js';

/**
 * The central server's half: the discovery map, from the fleet. An app is in it when one of its
 * instances sent a URL with its heartbeat (`fleet.url` / `APP_URL`); its `url` is the one its most
 * recently seen live instance sent, and `live` counts the instances up right now. Apps that are
 * known but have no live instance are listed with `live: 0`.
 *
 * Scoped by the caller's verified token: a caller sees the apps of its own environment (the
 * `environment` its token carries; a token without one sees apps that report none). Names are app
 * names that are a single DNS label, so they can be written as a URL host.
 */

const NAME_RE = /^[a-z0-9_-]{1,63}$/;

/** The map a caller in `environment` sees, at `now`. */
export function buildDiscoveryMap(
  instances: readonly InstanceRecord[],
  environment: string | null,
  now: number,
  goneAfterIntervals: number,
): DiscoveryMap {
  const byApp = new Map<
    string,
    { url: string; lastSeenAt: number; live: number; liveUrl: boolean }
  >();
  for (const instance of instances) {
    if ((instance.environment ?? null) !== environment) continue;
    const name = instance.app.toLowerCase();
    if (!NAME_RE.test(name) || typeof instance.url !== 'string' || instance.url === '') continue;
    const up = instanceStatus(instance, now, goneAfterIntervals) === 'up';
    const seen = byApp.get(name);
    if (seen === undefined) {
      byApp.set(name, {
        url: instance.url,
        lastSeenAt: instance.lastSeenAt,
        live: up ? 1 : 0,
        liveUrl: up,
      });
      continue;
    }
    if (up) seen.live += 1;
    // The URL of the most recently seen live instance wins; a live one beats any gone one.
    if ((up && !seen.liveUrl) || (up === seen.liveUrl && instance.lastSeenAt > seen.lastSeenAt)) {
      seen.url = instance.url;
      seen.lastSeenAt = instance.lastSeenAt;
      seen.liveUrl = up;
    }
  }
  const apps: Record<string, DiscoveredApp> = {};
  for (const name of [...byApp.keys()].sort()) {
    const app = byApp.get(name) as { url: string; live: number };
    apps[name] = { url: app.url, live: app.live };
  }
  const version = createHash('sha256').update(JSON.stringify(apps)).digest('hex').slice(0, 16);
  return { version, apps };
}

/** Options of {@link DiscoveryPublisher}. */
export interface DiscoveryPublisherOptions {
  /** The fleet's instances (within the retention). */
  instances: () => Promise<InstanceRecord[]>;
  goneAfterIntervals: number;
  /** How often waiting callers are re-checked. Default 1000 ms. */
  tickMs?: number;
  now?: () => number;
}

interface Waiter {
  environment: string | null;
  since: string;
  deadline: number;
  resolve: (map: DiscoveryMap) => void;
}

/**
 * Serves the map, and holds a caller that already has the current version until it changes
 * (long poll): one read of the fleet per tick, shared by every waiting caller, and an immediate
 * re-check on each heartbeat.
 */
export class DiscoveryPublisher {
  private readonly waiters = new Set<Waiter>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DiscoveryPublisherOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The map for `environment` now. */
  async current(environment: string | null): Promise<DiscoveryMap> {
    return buildDiscoveryMap(
      await this.options.instances(),
      environment,
      this.now(),
      this.options.goneAfterIntervals,
    );
  }

  /**
   * The map for `environment`: at once when its version is not `since`, else when it changes, or
   * after `waitMs` (the same version again). `signal` aborts the wait (the caller hung up).
   */
  async wait(
    environment: string | null,
    since: string | null,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryMap> {
    const map = await this.current(environment);
    if (since === null || map.version !== since || waitMs <= 0 || signal?.aborted) return map;
    return new Promise<DiscoveryMap>((resolve) => {
      const waiter: Waiter = { environment, since, deadline: this.now() + waitMs, resolve };
      this.waiters.add(waiter);
      // The caller hung up: stop holding (and re-checking) its request.
      signal?.addEventListener(
        'abort',
        () => {
          if (this.waiters.delete(waiter)) resolve(map);
        },
        { once: true },
      );
      this.ensureTimer();
    });
  }

  /** Callers being held right now. */
  get pending(): number {
    return this.waiters.size;
  }

  /** Re-check the waiting callers now (a heartbeat arrived). */
  poke(): void {
    if (this.waiters.size > 0) void this.tick();
  }

  /** Answer every waiting caller with the current map, and stop. */
  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      try {
        waiter.resolve(await this.current(waiter.environment));
      } catch {
        waiter.resolve({ version: waiter.since, apps: {} });
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref?.();
  }

  private tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    const run = (async () => {
      let instances: InstanceRecord[];
      try {
        instances = await this.options.instances();
      } catch {
        return;
      }
      const now = this.now();
      const maps = new Map<string | null, DiscoveryMap>();
      for (const waiter of [...this.waiters]) {
        let map = maps.get(waiter.environment);
        if (map === undefined) {
          map = buildDiscoveryMap(
            instances,
            waiter.environment,
            now,
            this.options.goneAfterIntervals,
          );
          maps.set(waiter.environment, map);
        }
        if (map.version !== waiter.since || now >= waiter.deadline) {
          this.waiters.delete(waiter);
          waiter.resolve(map);
        }
      }
      if (this.waiters.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    })().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }
}
