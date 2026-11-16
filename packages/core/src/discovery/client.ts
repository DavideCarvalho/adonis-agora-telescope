import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runAsTelescopeWork } from '../self_scope.js';
import { serverPrefix } from '../topology/config.js';
import { ServerUrl } from '../topology/server_url.js';
import { readToken, resetToken, type TenantTokenSource } from '../topology/verify.js';
import { APP_HEADER } from '../topology/wire.js';
import { markInternalFetch } from '../watchers/http_client_watcher.js';
import type { DiscoveryMap, ServiceDirectory } from './directory.js';

/** Options of {@link DiscoveryClient}. */
export interface DiscoveryClientOptions {
  /**
   * The central server's route prefix (`https://telescope.example.com/_telescope/v1`), or the
   * tenant's lazy server URL (resolved on the first poll, looked up again when unreachable).
   */
  prefix: string | ServerUrl;
  token: TenantTokenSource;
  /** This app's name (advisory: the token decides). */
  partition: string;
  directory: ServiceDirectory;
  /** Where the last map is saved, and read back at boot. */
  snapshotPath: string;
  /** How long the server may hold a request open. Default 25 s. */
  waitMs?: number;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}

/**
 * A saved snapshot, or `null` when there is none, it is unreadable, or it was written for another
 * scope (another app or server sharing the path).
 */
export function readSnapshot(path: string, scope?: string): DiscoveryMap | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiscoveryMap> & {
      scope?: unknown;
    };
    if (
      typeof parsed.version !== 'string' ||
      parsed.apps === null ||
      typeof parsed.apps !== 'object'
    ) {
      return null;
    }
    if (scope !== undefined && parsed.scope !== scope) return null;
    return { version: parsed.version, apps: parsed.apps };
  } catch {
    return null;
  }
}

/** Save `map` atomically (a temp file renamed over the old one), stamped with its scope. */
export async function writeSnapshot(
  path: string,
  map: DiscoveryMap,
  scope?: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const stamped = { ...map, ...(scope !== undefined ? { scope } : {}) };
  await writeFile(temp, JSON.stringify({ ...stamped, savedAt: new Date().toISOString() }));
  await rename(temp, path);
}

/**
 * A tenant's copy of the central server's map: the saved snapshot at boot, then a long poll that
 * the server answers as soon as the map changes. While the server is unreachable the last map
 * stays in use (and on disk), and the poll retries with backoff.
 */
export class DiscoveryClient {
  private stopped = true;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly server: ServerUrl;

  /** Who the snapshot belongs to: this server and this app (whose token decides the scope). */
  private readonly scope: string;

  constructor(private readonly options: DiscoveryClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.server =
      options.prefix instanceof ServerUrl ? options.prefix : new ServerUrl(options.prefix);
    // A lazy URL is not known at boot: its snapshot is scoped to the app alone.
    const known = this.server.current;
    this.scope = `${known !== null ? serverPrefix(known) : 'tenant.url'}#${options.partition}`;
  }

  /** Load the snapshot (synchronously, before the first request), then start polling. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const saved = readSnapshot(this.options.snapshotPath, this.scope);
    if (saved !== null) this.options.directory.update(saved);
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  /** One request: `true` when the server answered. Exposed for tests. */
  async pollOnce(waitMs = this.options.waitMs ?? 25_000): Promise<boolean> {
    const directory = this.options.directory;
    const params = new URLSearchParams({ wait: String(Math.round(waitMs / 1000)) });
    if (directory.version !== null) params.set('since', directory.version);
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), waitMs + 10_000);
    try {
      const prefix = serverPrefix(await this.server.get());
      const token = await runAsTelescopeWork(() => readToken(this.options.token));
      const response = await runAsTelescopeWork(() =>
        this.fetchImpl(
          `${prefix}/discovery?${params}`,
          markInternalFetch({
            headers: { authorization: `Bearer ${token}`, [APP_HEADER]: this.options.partition },
            signal: controller.signal,
          }),
        ),
      );
      if (response.status === 401) resetToken(this.options.token);
      // The server moved: the next poll looks the URL up again.
      if (response.status === 404 && this.server.lazy) await this.server.refresh();
      if (!response.ok) {
        this.options.onError?.(`the central server answered ${response.status} to /discovery`);
        return false;
      }
      const body = (await response.json()) as Partial<DiscoveryMap>;
      if (typeof body.version !== 'string' || body.apps === null || typeof body.apps !== 'object') {
        return false;
      }
      const map: DiscoveryMap = { version: body.version, apps: body.apps };
      if (map.version !== directory.version) {
        directory.update(map);
        await writeSnapshot(this.options.snapshotPath, map, this.scope).catch((error: unknown) =>
          this.options.onError?.(
            `could not save the discovery snapshot: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      return true;
    } catch (error) {
      if (!this.stopped && this.server.lazy && this.server.current !== null) {
        await this.server.refresh();
      }
      if (!this.stopped) {
        this.options.onError?.(
          `could not read the discovery map: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      const ok = await this.pollOnce();
      if (this.stopped) return;
      if (ok) {
        backoff = 1000;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, backoff).unref?.());
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}
