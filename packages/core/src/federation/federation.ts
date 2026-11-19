import { durationToMs } from '../alerts/parse_duration.js';
import type { Entry, RecordInput } from '../entry.js';
import { type EntryQuery, forwardOptionalReads, type TelescopeStore } from '../store.js';
import type { StoreProvider } from '../stores/factory.js';
import { appOfTag, appTag } from '../ui/app_scope.js';
import {
  ConsoleCommandError,
  type ConsoleCommandReply,
  ConsoleCommandSender,
  type ConsoleRedisClient,
  DEFAULT_CONSOLE_PREFIX,
  FEDERATED_APP_UNREACHABLE,
} from './console_commands.js';
import { FederatedReadStore } from './read_store.js';

/** Where a federated app's console commands go: that app's Redis and the prefix it answers on. */
export interface FederatedCommandsConfig {
  /** An `@adonisjs/redis` connection name (`config/redis.ts`) of THIS app reaching that app's Redis. Default the default connection. */
  connection?: string;
  /** The `prefix` the other app sets in its `consoleCommands`. Default `telescope`. */
  prefix?: string;
  /** Escape hatch: an `ioredis` client used instead of `@adonisjs/redis`. */
  client?: ConsoleRedisClient;
}

/** One app the console reads from its own store (`config/telescope_ui.ts` → `apps.federated`). */
export interface FederatedAppConfig {
  /** The name in the App picker. Default the key. */
  label?: string;
  /**
   * That app's telescope store: `storage.lucid({ connection, schema })` naming where ITS entries
   * are (or `storage.tiered(...)` with the same tiers it uses). Only read: never created,
   * migrated, written or pruned from here.
   */
  store: StoreProvider | TelescopeStore;
  /**
   * Where actions (request replay, queue retries) and live reads (queues, schedules, health) are
   * sent, run by the app itself. Omit it (or `false`) to browse the app read-only.
   */
  commands?: FederatedCommandsConfig | false;
  /** How long a command waits for the app to answer, in ms. Default 15,000. */
  timeoutMs?: number;
  /** The longest window an aggregate reads (`'24h'`, ms). Default `'24h'`. */
  maxWindow?: string | number;
  /** How far back a search or tag filter looks, when it names no start. Default `'24h'`. */
  searchWindow?: string | number;
  /** Most rows one read returns. Default 5,000. */
  maxRows?: number;
  /** Queries run at once against that app's database. Default 4. */
  maxConcurrentReads?: number;
}

/** Who runs actions on a federated app's data: the app itself, or nobody (read-only). */
export type FederatedActions = 'app' | 'none';

/** What a federated app needs from the host app to build its store and command channel. */
export interface FederationContext {
  /** The host AdonisJS app (resolves `lucid.db`, `redis`). */
  app: unknown;
}

/** App keys: what `?app=` carries. */
const APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A federated app: its read-only store and, when it answers them, its console commands. */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly actions: FederatedActions;
  private storePromise: Promise<TelescopeStore> | null = null;
  private sender: ConsoleCommandSender | null = null;

  constructor(
    id: string,
    private readonly config: FederatedAppConfig,
    private readonly context: FederationContext,
  ) {
    this.id = id;
    this.label = config.label ?? id;
    this.actions = config.commands ? 'app' : 'none';
  }

  /** The app's store, read-only and bounded; built on first use (a failed build is retried). */
  store(): Promise<TelescopeStore> {
    if (this.storePromise === null) {
      const attempt = this.buildStore();
      this.storePromise = attempt;
      attempt.catch(() => {
        if (this.storePromise === attempt) this.storePromise = null;
      });
    }
    return this.storePromise;
  }

  private async buildStore(): Promise<TelescopeStore> {
    const source = this.config.store;
    const built =
      typeof source === 'function'
        ? await source({ app: this.context.app } as Parameters<StoreProvider>[0])
        : source;
    const view = built as TelescopeStore & { readOnlyView?: () => TelescopeStore };
    const inner = typeof view.readOnlyView === 'function' ? view.readOnlyView() : built;
    const ms = (value: string | number | undefined) =>
      value === undefined ? undefined : durationToMs(value);
    const maxWindowMs = ms(this.config.maxWindow);
    const searchWindowMs = ms(this.config.searchWindow);
    return new FederatedReadStore(inner, {
      ...(maxWindowMs !== undefined ? { maxWindowMs } : {}),
      ...(searchWindowMs !== undefined ? { searchWindowMs } : {}),
      ...(this.config.maxRows !== undefined ? { maxRows: this.config.maxRows } : {}),
      ...(this.config.maxConcurrentReads !== undefined
        ? { maxConcurrentReads: this.config.maxConcurrentReads }
        : {}),
    });
  }

  /**
   * Run `verb` on the app. Answers the app's own status and body; `503` when the app cannot be
   * reached (no instance answers commands, no reply in time), `404` when it answers none.
   */
  async run(
    verb: string,
    args: unknown[],
    actor?: string,
  ): Promise<{ status: number; body: unknown }> {
    if (this.actions === 'none') {
      return {
        status: 404,
        body: {
          error: `${this.label} is federated and read-only here: change it in ${this.label} itself.`,
        },
      };
    }
    let reply: ConsoleCommandReply;
    try {
      reply = await (await this.commandSender()).send(verb, args, actor);
    } catch (error) {
      const code = error instanceof ConsoleCommandError ? error.code : undefined;
      return {
        status: 503,
        body: {
          error: `${this.label}: ${error instanceof Error ? error.message : String(error)}`,
          code: code ?? FEDERATED_APP_UNREACHABLE,
        },
      };
    }
    if (!reply.ok) {
      return {
        status: reply.error?.code === 'unsupported-request' ? 501 : 502,
        body: { error: `${this.label}: ${reply.error?.message ?? 'the app refused the command'}` },
      };
    }
    return { status: reply.status, body: reply.body };
  }

  private async commandSender(): Promise<ConsoleCommandSender> {
    if (this.sender !== null) return this.sender;
    const commands = this.config.commands as FederatedCommandsConfig;
    const client =
      commands.client ?? (await redisConnection(this.context.app, commands.connection));
    this.sender ??= new ConsoleCommandSender(client, {
      app: this.label,
      prefix: commands.prefix ?? DEFAULT_CONSOLE_PREFIX,
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
    });
    return this.sender;
  }

  close(): void {
    this.sender?.close();
    this.sender = null;
  }
}

/** The `redis` connection `name` of `app` (`@adonisjs/redis`). */
export async function redisConnection(app: unknown, name?: string): Promise<ConsoleRedisClient> {
  const container = (
    app as { container?: { hasBinding?(b: string): boolean; make(b: string): Promise<unknown> } }
  )?.container;
  if (
    container === undefined ||
    (typeof container.hasBinding === 'function' && !container.hasBinding('redis'))
  ) {
    throw new ConsoleCommandError(
      'console commands need @adonisjs/redis configured (node ace add @adonisjs/redis), or a `client`',
      FEDERATED_APP_UNREACHABLE,
    );
  }
  const redis = (await container.make('redis')) as {
    connection(name?: string): ConsoleRedisClient;
  };
  return redis.connection(name);
}

/** The federated apps a console reads. */
export class Federation {
  private readonly apps = new Map<string, FederatedApp>();

  constructor(configs: Record<string, FederatedAppConfig>, context: FederationContext) {
    for (const [id, config] of Object.entries(configs)) {
      if (!APP_KEY.test(id)) {
        throw new Error(
          `[@adonis-agora/telescope] apps.federated: "${id}" is not a valid app key (1-64 of A-Z a-z 0-9 _ . -).`,
        );
      }
      if (config === null || typeof config !== 'object' || config.store === undefined) {
        throw new Error(`[@adonis-agora/telescope] apps.federated.${id} needs a \`store\`.`);
      }
      this.apps.set(id, new FederatedApp(id, config, context));
    }
    // The prefix is all that tells two apps' commands apart on one Redis: a shared one would let
    // either app claim (and run) the other's commands.
    const byChannel = new Map<string, string>();
    for (const [id, config] of Object.entries(configs)) {
      const commands = config.commands;
      if (!commands || commands.client !== undefined) continue;
      const channel = `${commands.connection ?? ''}\u0000${commands.prefix ?? DEFAULT_CONSOLE_PREFIX}`;
      const other = byChannel.get(channel);
      if (other !== undefined) {
        throw new Error(
          `[@adonis-agora/telescope] apps.federated: "${other}" and "${id}" send commands on the same Redis connection with the same prefix "${commands.prefix ?? DEFAULT_CONSOLE_PREFIX}". Give each app its own \`consoleCommands.prefix\`.`,
        );
      }
      byChannel.set(channel, id);
    }
  }

  get size(): number {
    return this.apps.size;
  }

  get(id: string | undefined): FederatedApp | undefined {
    return id === undefined ? undefined : this.apps.get(id);
  }

  /** Every federated app, in configuration order. */
  list(): FederatedApp[] {
    return [...this.apps.values()];
  }

  close(): void {
    for (const app of this.apps.values()) app.close();
  }
}

/** One federated app's store, as the trace views merge it in. */
export interface TraceSource {
  id: string;
  store: () => Promise<TelescopeStore>;
}

/** How long the trace views wait for one federated app's spans. */
const TRACE_SOURCE_TIMEOUT_MS = 3_000;

/**
 * The console's own store, with the spans other apps recorded in their own stores merged into the
 * reads of one trace (`list({ traceId })`, an index read on each store) and the entries they
 * hold found by id, so a trace that crossed into a federated app shows whole. Each merged entry
 * carries `app:<id>`. A federated app that fails or is slow (3 s) is left out.
 */
export class TraceMergingStore implements TelescopeStore {
  constructor(
    private readonly primary: TelescopeStore,
    private readonly sources: readonly TraceSource[],
    private readonly timeoutMs = TRACE_SOURCE_TIMEOUT_MS,
  ) {
    forwardOptionalReads(this, primary);
  }

  record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    return this.primary.record(input);
  }

  async get(id: string): Promise<Entry | null> {
    const own = await this.primary.get(id);
    if (own !== null || this.sources.length === 0) return own;
    // Asked of every federated app at once: one slow app costs its timeout, not the sum.
    const found = await Promise.all(
      this.sources.map((source) => this.fromSource(source, (store) => store.get(id), null)),
    );
    const index = found.findIndex((entry) => entry !== null);
    const source = this.sources[index];
    return index === -1 || source === undefined ? null : tagged(found[index] as Entry, source.id);
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    if (query.traceId === undefined || this.sources.length === 0) return this.primary.list(query);
    const [own, ...others] = await Promise.all([
      this.primary.list(query),
      ...this.sources.map((source) =>
        this.fromSource(source, (store) => store.list(query), [] as Entry[]).then((rows) =>
          rows.map((row) => tagged(row, source.id)),
        ),
      ),
    ]);
    if (others.every((rows) => rows.length === 0)) return own;
    const seen = new Set(own.map((entry) => entry.id));
    const merged = [...own];
    for (const rows of others) {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
    }
    merged.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.sequence - a.sequence,
    );
    return query.size !== undefined && query.size > 0 ? merged.slice(0, query.size) : merged;
  }

  count(): Promise<number> {
    return this.primary.count();
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.primary.prune(olderThan, keepLast);
  }

  clear(): Promise<void> {
    return this.primary.clear();
  }

  private async fromSource<T>(
    source: TraceSource,
    read: (store: TelescopeStore) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        source.store().then(read),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), this.timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** `entry` carrying `app:<id>` (unless it already names an app). */
export function tagged(entry: Entry, id: string): Entry {
  if (entry.tags.some((tag) => appOfTag(tag) !== undefined)) return entry;
  return { ...entry, tags: [...entry.tags, appTag(id)] };
}
