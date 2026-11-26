import { durationToMs } from '../alerts/parse_duration.js';
import type { Entry, RecordInput } from '../entry.js';
import { type EntryQuery, forwardOptionalReads, type TelescopeStore } from '../store.js';
import type { StoreProvider } from '../stores/factory.js';
import type { TenantTokenSource } from '../topology/verify.js';
import { appOfTag, appTag } from '../ui/app_scope.js';
import { ALL_CONSOLE_COMMAND_CAPABILITIES } from './answer.js';
import {
  AppCallTokenError,
  appCallTokenSource,
  authkitOf,
  CONSOLE_KEY_PURPOSE,
  ConsoleAuthConfigError,
  consoleSideCipher,
  consoleUnauthenticatedMessage,
  cryptoRuntimeOf,
  directoryConsoleKey,
  hasCryptoBinding,
  isMissingGrant,
  optionalAppCallToken,
  planConsoleAuth,
  RECONSIDER_MS,
  requiredAppCallToken,
  withoutTokenLine,
} from './auto_crypto.js';
import {
  type ChannelSecret,
  ConsoleCommandError,
  type ConsoleCommandReply,
  ConsoleCommandSender,
  type ConsoleCryptoOptions,
  type ConsolePublicKey,
  type ConsolePublicKeySource,
  type ConsoleRedisClient,
  DEFAULT_CONSOLE_PREFIX,
  FEDERATED_APP_UNREACHABLE,
  UNAUTHORIZED_CONSOLE,
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
  /**
   * How this console proves itself to that app (one is required; the app answers nothing else).
   *
   * Shared-secret mode (no authkit, no crypto): the secret shared with that app (its
   * `consoleCommands.secret`), 16+ characters. Every command and answer carries an HMAC.
   */
  secret?: ChannelSecret;
  /**
   * Token mode: this console's token for that app, e.g. `authkitTenantToken({ issuer, clientId,
   * clientSecret, resource: 'urn:agora:telescope' })` of a service-tenant client whose `partition`
   * is that app and whose capabilities say what this console may do there
   * (`telescope:console:read`, `telescope:console:queues`, `telescope:console:replay`). The app
   * checks it with its `consoleCommands.verifyTenant`. Needs `publicKey` (or `crypto`).
   */
  token?: TenantTokenSource | false;
  /**
   * Token mode: that app's console key (`x25519:…`), which `node ace telescope:console:key` prints
   * on that app (its boot log shows only a short id). Commands and their token are sealed to it. Copy it from
   * the app, never from Redis.
   */
  publicKey?: ConsolePublicKey;
  /**
   * Sealed with `@adonis-agora/crypto`: the cipher this console encrypts with, for a key of that
   * app (`console-telescope` by default) it may `encrypt` with and the app may `decrypt`. Where
   * crypto is embedded in this app (the Hub): `() => serviceCipher(crypto.service, '<the app's
   * partition>')`; on a tenant of a crypto server: a client for that partition. Combine with
   * `token` when the app also checks one.
   *
   * Nothing to set when `@adonis-agora/crypto` is embedded in this console (the Agora Hub) and none
   * of `secret`, `token` and `crypto` is set: commands are sealed with the `console-telescope` key
   * of the app's crypto partition ({@link FederatedAppConfig.partition}), created when missing.
   * `false` turns that automatic mode off.
   */
  crypto?: ConsoleCryptoOptions | false;
}

/** One app the console reads from its own store (`config/telescope_ui.ts` → `apps.federated`). */
export interface FederatedAppConfig {
  /** The name in the App picker. Default the key. */
  label?: string;
  /**
   * That app's `@adonis-agora/crypto` partition (its crypto app name), where the automatic crypto
   * mode seals its commands with `console-telescope`. Default the key.
   */
  partition?: string;
  /**
   * That app's telescope store: `storage.lucid({ connection, schema })` naming where ITS entries
   * are (or `storage.tiered(...)` with the same tiers it uses). Only read: never created,
   * migrated, written or pruned from here.
   */
  store: StoreProvider | TelescopeStore;
  /**
   * Where actions (request replay, queue retries) and live reads (queues, schedules, health) are
   * sent, run by the app itself. On by default, like every Agora console's `actions`: omitted, it
   * is `{}` (the app's default prefix `telescope`, this console's default Redis connection) when
   * that channel is free for it. `false` browses the app read-only (the equivalent of other
   * consoles' `actions: false`).
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
  /** The host AdonisJS app (resolves `lucid.db`, `redis`, `agora.crypto`). */
  app: unknown;
  /**
   * Throw when a federated app has `commands` but no authentication resolves (the web process:
   * a console that cannot send would only time out later).
   */
  strict?: boolean;
  /**
   * Whether authkit's calls between apps give this console an app-call token source (resolved at
   * boot from the `authkit.client` binding; a binding without one provides nothing).
   */
  authkitTokens?: boolean;
  /** Whether authkit's key directory can give an app's console key (`appKey` on the manager). */
  authkitDirectory?: boolean;
  /** Called once per partition whose console key this console created (logged at boot). */
  onKeyCreated?: (partition: string) => void;
  /** A warning to log (an app-call token that could not be minted, §13b). */
  warn?: (line: string) => void;
  /** An info line to log (the same, when only a grant is missing, §13b). */
  info?: (line: string) => void;
}

/** App keys: what `?app=` carries. */
const APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A federated app: its read-only store and, when it answers them, its console commands. */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly actions: FederatedActions;
  /** That app's crypto partition (automatic crypto mode). */
  readonly partition: string;
  /** How commands are authenticated: a label, `null` when none resolves (or no `commands`). */
  readonly authMode: string | null;
  private readonly autoCrypto: boolean;
  private readonly autoToken: boolean;
  /** Token mode without `publicKey`: the app's key comes from authkit's key directory. */
  private readonly directoryKey: boolean;
  /** §13a: token mode when the app publishes a directory key, else crypto, per command. */
  private readonly lazy: boolean;
  /** The lazy choice, and when it was made (reconsidered after 5 min, or on a timeout). */
  private choice: { kind: SenderKind; at: number } | null = null;
  private storePromise: Promise<TelescopeStore> | null = null;
  private readonly senders = new Map<SenderKind, Promise<ConsoleCommandSender>>();
  private readonly built = new Set<ConsoleCommandSender>();
  private sideCipher: Promise<ReturnType<typeof consoleSideCipher>> | null = null;

  /** Why the app is browse-only when `commands` was omitted (logged at boot), if it is. */
  readonly browseOnlyNote: string | undefined;

  constructor(
    id: string,
    private readonly config: FederatedAppConfig,
    private readonly context: FederationContext,
    browseOnlyNote?: string,
  ) {
    this.id = id;
    this.browseOnlyNote = browseOnlyNote;
    this.label = config.label ?? id;
    this.actions = config.commands ? 'app' : 'none';
    this.partition = config.partition ?? id;
    const container = appContainer(context.app);
    const plan = config.commands
      ? planConsoleAuth(config.commands, {
          cryptoBound: hasCryptoBinding(container),
          authkitBound: context.authkitTokens === true,
          partition: this.partition,
          keyDirectory: context.authkitDirectory === true,
        })
      : null;
    this.authMode = plan?.mode ?? null;
    this.autoCrypto = plan?.autoCrypto === true;
    this.autoToken = plan?.autoToken === true;
    this.directoryKey = plan?.directoryKey === true;
    this.lazy = plan?.lazy === true;
    if (config.commands && plan === null && context.strict === true) {
      throw new ConsoleAuthConfigError(consoleUnauthenticatedMessage(id, config.commands));
    }
  }

  /** The automatic crypto cipher for this app (built once; its key check retries by itself). */
  private sideCipherOf(): Promise<ReturnType<typeof consoleSideCipher>> {
    if (this.sideCipher === null) {
      const attempt = cryptoRuntimeOf(appContainer(this.context.app)).then((runtime) => {
        if (runtime === undefined) throw new Error('@adonis-agora/crypto is not booted');
        return consoleSideCipher(runtime, this.partition, undefined, () =>
          this.context.onKeyCreated?.(this.partition),
        );
      });
      this.sideCipher = attempt;
      attempt.catch(() => {
        if (this.sideCipher === attempt) this.sideCipher = null;
      });
    }
    return this.sideCipher;
  }

  /**
   * Automatic crypto mode with crypto embedded in this console: create the `console-telescope`
   * key in the app's partition when missing. Runs once; a failure is retried on the first
   * command. A no-op otherwise (a console that is a crypto tenant only seals).
   */
  async prepare(): Promise<void> {
    if (!this.autoCrypto) return;
    await (await this.sideCipherOf()).ready();
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
    /** The viewer's capabilities (always sent). Default every console capability. */
    capabilities: readonly string[] = ALL_CONSOLE_COMMAND_CAPABILITIES,
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
    const send = async (kind: SenderKind) =>
      (await this.commandSender(kind)).send(verb, args, actor, {
        capabilities: [...capabilities],
      });
    try {
      const kind = await this.pick();
      try {
        reply = await send(kind);
      } catch (error) {
        if (!(kind === 'token' && error instanceof AppCallTokenError)) {
          // Any other failure (a timeout: an app that refused the mode drops the command, it
          // cannot sign a reply): the lazy choice is made again on the next command (§13e).
          this.choice = null;
          throw error;
        }
        // §13a: token mode was chosen from the directory, but no app-call token could be minted
        // (a key published by an older version of the app, no grant…): crypto instead, for this
        // command and the next ones for RECONSIDER_MS (no failing mint per command meanwhile).
        this.warnOnce(withoutTokenLine(this.partition, error.reason), error.source);
        this.choice = { kind: 'crypto', at: Date.now() };
        reply = await send('crypto');
      }
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
      // The app answered, so it accepts the mode: the lazy choice stands (§13e).
      const code = reply.error?.code;
      return {
        status: code === 'unsupported-request' ? 501 : 502,
        body: {
          error: `${this.label}: ${reply.error?.message ?? 'the app refused the command'}`,
          ...(code === UNAUTHORIZED_CONSOLE ? { code } : {}),
        },
      };
    }
    return { status: reply.status, body: reply.body };
  }

  private readonly said = new Set<string>();

  /** The §13b line, once: `info` for a missing grant, `warn` for anything else. */
  private warnOnce(line: string, error: unknown): void {
    if (this.said.has(line)) return;
    this.said.add(line);
    if (isMissingGrant(error)) this.context.info?.(line);
    else this.context.warn?.(line);
  }

  /**
   * Which sender a command goes through. Fixed for every entry but a lazy one (§13a), which asks
   * authkit's key directory: a key there means the app runs token mode, else crypto. The choice is
   * kept {@link RECONSIDER_MS}, and dropped when a command gets no answer.
   */
  private async pick(): Promise<SenderKind> {
    if (!this.lazy) return 'plan';
    const now = Date.now();
    if (this.choice !== null && now - this.choice.at < RECONSIDER_MS) return this.choice.kind;
    let kind: SenderKind = 'crypto';
    try {
      const authkit = await authkitOf(appContainer(this.context.app));
      const key = await authkit?.appKey?.({ app: this.partition, purpose: CONSOLE_KEY_PURPOSE });
      if (key) kind = 'token';
    } catch {
      // The directory is unreachable: crypto, which needs nothing from it.
    }
    this.choice = { kind, at: now };
    return kind;
  }

  private commandSender(kind: SenderKind): Promise<ConsoleCommandSender> {
    let sender = this.senders.get(kind);
    if (sender === undefined) {
      const attempt = this.buildSender(kind);
      this.senders.set(kind, attempt);
      attempt.then(
        (made) => this.built.add(made),
        () => {
          if (this.senders.get(kind) === attempt) this.senders.delete(kind);
        },
      );
      sender = attempt;
    }
    return sender;
  }

  private async buildSender(kind: SenderKind): Promise<ConsoleCommandSender> {
    const commands = this.config.commands as FederatedCommandsConfig;
    const container = appContainer(this.context.app);
    // The lazy kinds: 'crypto' seals with crypto (token optional), 'token' to the directory key.
    const cryptoMode = kind === 'crypto' || (kind === 'plan' && this.autoCrypto);
    const directoryMode = kind === 'token' || (kind === 'plan' && this.directoryKey);
    let crypto = commands.crypto === false ? undefined : commands.crypto;
    if (kind === 'token') crypto = undefined;
    else if (cryptoMode) crypto = { cipher: (await this.sideCipherOf()).cipher };
    // authkit's calls between apps: a token for this app (by its name, the partition). With
    // crypto it is optional (§13b); sealed to the app's key it is required.
    let token: TenantTokenSource | undefined =
      commands.token === false ? undefined : commands.token;
    if (token === undefined && commands.token !== false && this.autoToken) {
      const source = appCallTokenSource(await authkitOf(container), this.partition);
      if (source !== undefined) {
        token =
          crypto !== undefined
            ? optionalAppCallToken(source, this.partition, (line, error) =>
                this.warnOnce(line, error),
              )
            : requiredAppCallToken(source, this.partition);
      }
    }
    // An explicit `publicKey` wins; else, in token mode, authkit's key directory (§2e.B).
    let publicKey: ConsolePublicKeySource | undefined = commands.publicKey;
    if (publicKey === undefined && directoryMode) {
      const authkit = await authkitOf(container);
      if (authkit !== undefined && typeof authkit.appKey === 'function') {
        publicKey = directoryConsoleKey(authkit, this.partition, `apps.federated["${this.id}"]`);
      }
    }
    const client =
      commands.client ?? (await redisConnection(this.context.app, commands.connection));
    return new ConsoleCommandSender(client, {
      app: this.label,
      prefix: commands.prefix ?? DEFAULT_CONSOLE_PREFIX,
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
      ...(commands.secret !== undefined ? { secret: commands.secret } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(publicKey !== undefined ? { publicKey } : {}),
      ...(crypto !== undefined ? { crypto } : {}),
    });
  }

  close(): void {
    for (const sender of this.built) sender.close();
    this.built.clear();
    this.senders.clear();
    this.choice = null;
  }
}

/** Which sender a command goes through: the plan's own, or one side of a lazy choice (§13a). */
type SenderKind = 'plan' | 'crypto' | 'token';

function appContainer(app: unknown): unknown {
  return (app as { container?: unknown } | null | undefined)?.container;
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

/** One entry's `commands` once the default applies, and why it is browse-only when it is. */
export interface ResolvedFederatedCommands {
  commands: FederatedCommandsConfig | false;
  /** `true`: `commands` was omitted and took the default. */
  defaulted: boolean;
  /** Set when `commands` was omitted but could not take the default (logged at boot). */
  note?: string;
}

const channelOf = (commands: FederatedCommandsConfig) =>
  `${commands.connection ?? ''}\u0000${commands.prefix ?? DEFAULT_CONSOLE_PREFIX}`;

/**
 * `commands` is on by default (§10.9): an entry that omits it takes `{}`, the app side's own
 * defaults (prefix `telescope`, this console's default Redis connection), so zero configuration
 * also sends actions. Only one app can answer on that channel, so when several entries omit
 * `commands`, or an explicit one already uses it, those entries stay browse-only, each with a
 * note saying how to enable it.
 */
export function resolveFederatedCommands(
  configs: Record<string, Pick<FederatedAppConfig, 'commands'>>,
): Record<string, ResolvedFederatedCommands> {
  const omitted = Object.entries(configs)
    .filter(([, config]) => config?.commands === undefined)
    .map(([id]) => id);
  const taken = new Set(
    Object.values(configs)
      .map((config) => config?.commands)
      .filter((c): c is FederatedCommandsConfig => !!c && c.client === undefined)
      .map(channelOf),
  );
  const defaultFree = !taken.has(channelOf({}));
  const out: Record<string, ResolvedFederatedCommands> = {};
  for (const [id, config] of Object.entries(configs)) {
    if (config?.commands !== undefined) {
      out[id] = { commands: config.commands, defaulted: false };
    } else if (omitted.length === 1 && defaultFree) {
      out[id] = { commands: {}, defaulted: true };
    } else {
      out[id] = {
        commands: false,
        defaulted: false,
        note: `browse-only: ${
          defaultFree
            ? `${omitted.length} federated apps omit \`commands\`, and only one can take the default channel`
            : 'another federated app already uses the default channel'
        } (prefix "${DEFAULT_CONSOLE_PREFIX}" on the default Redis connection); set apps.federated.${id}.commands to { prefix: '<its consoleCommands.prefix>' } to send it actions, or commands: false to browse it read-only without this line`,
      };
    }
  }
  return out;
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
    }
    const resolved = resolveFederatedCommands(configs);
    for (const [id, config] of Object.entries(configs)) {
      const { commands, note } = resolved[id] as ResolvedFederatedCommands;
      this.apps.set(id, new FederatedApp(id, { ...config, commands }, context, note));
    }
    // The prefix is all that tells two apps' commands apart on one Redis: a shared one would let
    // either app claim (and run) the other's commands.
    const byChannel = new Map<string, string>();
    for (const id of Object.keys(configs)) {
      const commands = (resolved[id] as ResolvedFederatedCommands).commands;
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
