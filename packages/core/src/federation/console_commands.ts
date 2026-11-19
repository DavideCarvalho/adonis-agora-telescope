import { randomUUID } from 'node:crypto';
import { dedicatedConnection } from '../topology/transports/redis.js';

/**
 * Console commands: the actions a console runs on an app whose entries it reads from that app's
 * own store (a federated app). The console publishes each command on the app's Redis; every
 * instance of the app that answers commands hears it, one claims it (`SET … NX`) and runs it, and
 * its reply comes back on a reply channel. Nothing is queued: a publish no instance hears fails at
 * once, and a reply that does not come in time is a timeout.
 */

/** The Redis client commands travel through: an `@adonisjs/redis` connection or an `ioredis` client. */
export interface ConsoleRedisClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
}

/** The subscriber connection, duplicated from the client (Redis pub/sub takes a connection of its own). */
interface SubscriberConnection {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  disconnect(): void;
}

/** One command, as published. */
export interface ConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who asked, for the owning app's log. */
  actor?: string;
}

/** What the owning app answers: the HTTP status and body its own console handler produced. */
export type ConsoleCommandReply =
  | { id: string; ok: true; status: number; body: unknown }
  | { id: string; ok: false; error: { message: string; code?: string } };

/** The code of an error a command gets when no instance of the owning app answered. */
export const FEDERATED_APP_UNREACHABLE = 'federated-app-unreachable';

/** A command the owning app did not run (nobody listened, no answer in time, or it refused). */
export class ConsoleCommandError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ConsoleCommandError';
    this.code = code;
  }
}

/** Default Redis key prefix (the owning app's `consoleCommands.prefix`). */
export const DEFAULT_CONSOLE_PREFIX = 'telescope';
/** Default wait for a reply. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/** How long a claim is kept: past it a duplicate delivery could run again, long after the first. */
const CLAIM_TTL_MS = 5 * 60_000;

/** The channels and keys of one app's console commands. */
export function consoleChannels(prefix: string = DEFAULT_CONSOLE_PREFIX) {
  return {
    commands: `${prefix}:telescope-console`,
    replies: `${prefix}:telescope-console-reply`,
    claim: (id: string) => `${prefix}:telescope-console-claim:${id}`,
  };
}

function subscriberOf(client: ConsoleRedisClient): SubscriberConnection {
  const connection = dedicatedConnection(client) as unknown as SubscriberConnection | null;
  if (connection === null) {
    throw new ConsoleCommandError(
      'console commands need a Redis client that can open a subscriber connection (an @adonisjs/redis connection or an ioredis client)',
    );
  }
  connection.on('error', () => {
    // ioredis reconnects by itself; an unhandled 'error' would crash the process.
  });
  return connection;
}

/**
 * The console's side: sends commands to one app and waits for the reply. The reply channel is
 * subscribed on the first send.
 */
export class ConsoleCommandSender {
  private readonly channels: ReturnType<typeof consoleChannels>;
  private subscriber: SubscriberConnection | null = null;
  private subscribed: Promise<void> | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (reply: ConsoleCommandReply) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly client: ConsoleRedisClient,
    private readonly options: { app: string; prefix?: string; timeoutMs?: number },
  ) {
    this.channels = consoleChannels(options.prefix);
  }

  /** Run `verb` on the app; resolves with its reply, rejects when it cannot be run there. */
  async send(verb: string, args: unknown[], actor?: string): Promise<ConsoleCommandReply> {
    await this.listen();
    const command: ConsoleCommand = {
      id: randomUUID(),
      verb,
      args,
      ...(actor !== undefined ? { actor } : {}),
    };
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<ConsoleCommandReply>((resolve, reject) => {
      this.pending.set(command.id, { resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(
          new ConsoleCommandError(
            `the "${this.options.app}" app did not answer within ${timeoutMs} ms`,
            FEDERATED_APP_UNREACHABLE,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    });
    reply.catch(() => {});
    let receivers: unknown;
    try {
      receivers = await this.client.call(
        'PUBLISH',
        this.channels.commands,
        JSON.stringify(command),
      );
    } catch (error) {
      this.settle(command.id, timer);
      throw new ConsoleCommandError(
        `could not reach the "${this.options.app}" app: ${error instanceof Error ? error.message : String(error)}`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    if (Number(receivers) === 0) {
      this.settle(command.id, timer);
      throw new ConsoleCommandError(
        `no instance of the "${this.options.app}" app answers console commands (is \`consoleCommands\` set in its config/telescope.ts?)`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    try {
      return await reply;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Stop listening; commands still waiting for a reply fail at once. */
  close(): void {
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.subscribed = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) {
      reject(
        new ConsoleCommandError(
          `stopped waiting for the "${this.options.app}" app`,
          FEDERATED_APP_UNREACHABLE,
        ),
      );
    }
  }

  private settle(id: string, timer: NodeJS.Timeout | undefined): void {
    this.pending.delete(id);
    if (timer) clearTimeout(timer);
  }

  private listen(): Promise<void> {
    if (this.subscribed === null) {
      const subscriber = subscriberOf(this.client);
      this.subscriber = subscriber;
      subscriber.on('message', (channel, message) => {
        if (channel !== this.channels.replies) return;
        const reply = parseReply(message);
        if (reply === null) return;
        const waiting = this.pending.get(reply.id);
        if (waiting === undefined) return;
        this.pending.delete(reply.id);
        waiting.resolve(reply);
      });
      const attempt = Promise.resolve(subscriber.subscribe(this.channels.replies)).then(() => {});
      this.subscribed = attempt;
      attempt.catch(() => {
        if (this.subscribed === attempt) this.close();
      });
    }
    return this.subscribed;
  }
}

/** Runs one command on the owning app: the status and body of its own console handler. */
export type ConsoleCommandHandler = (
  command: ConsoleCommand,
) => Promise<{ status: number; body: unknown }>;

/**
 * The owning app's side: every instance listens; the one that claims a command runs it and
 * publishes the reply. Returns a function that stops listening.
 */
export async function answerConsoleCommands(
  client: ConsoleRedisClient,
  handler: ConsoleCommandHandler,
  options: { prefix?: string; instanceId?: string; onError?: (message: string) => void } = {},
): Promise<() => void> {
  const channels = consoleChannels(options.prefix);
  const instance = options.instanceId ?? randomUUID();
  const subscriber = subscriberOf(client);
  const onMessage = async (message: string) => {
    const command = parseCommand(message);
    if (command === null) return;
    const claimed = await client.call(
      'SET',
      channels.claim(command.id),
      instance,
      'PX',
      CLAIM_TTL_MS,
      'NX',
    );
    if (claimed === null || claimed === undefined) return;
    let reply: ConsoleCommandReply;
    try {
      const { status, body } = await handler(command);
      reply = { id: command.id, ok: true, status, body };
    } catch (error) {
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof ConsoleCommandError && error.code !== undefined
            ? { code: error.code }
            : {}),
        },
      };
    }
    await client.call('PUBLISH', channels.replies, JSON.stringify(reply));
  };
  subscriber.on('message', (channel, message) => {
    if (channel !== channels.commands) return;
    onMessage(message).catch((error) =>
      options.onError?.(error instanceof Error ? error.message : String(error)),
    );
  });
  await subscriber.subscribe(channels.commands);
  return () => subscriber.disconnect();
}

function parseCommand(message: string): ConsoleCommand | null {
  try {
    const value = JSON.parse(message) as Partial<ConsoleCommand>;
    if (typeof value?.id !== 'string' || typeof value.verb !== 'string') return null;
    return {
      id: value.id,
      verb: value.verb,
      args: Array.isArray(value.args) ? value.args : [],
      ...(typeof value.actor === 'string' ? { actor: value.actor } : {}),
    };
  } catch {
    return null;
  }
}

/** A reply of either shape, or `null` (dropped like any other unreadable message). */
export function parseReply(message: string): ConsoleCommandReply | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.id !== 'string') return null;
  if (reply.ok === true && typeof reply.status === 'number') {
    return { id: reply.id, ok: true, status: reply.status, body: reply.body };
  }
  const error = reply.error as Record<string, unknown> | null | undefined;
  if (reply.ok === false && typeof error?.message === 'string') {
    return {
      id: reply.id,
      ok: false,
      error: {
        message: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
      },
    };
  }
  return null;
}
