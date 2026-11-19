/**
 * An in-memory Redis for the console-command tests: `PUBLISH` (answering the receiver count),
 * `SET … PX … NX`, and subscriber connections from `duplicate()`, like ioredis.
 */
export class FakeRedis {
  private readonly subscribers = new Map<string, Set<FakeSubscriber>>();
  readonly keys = new Map<string, string>();
  readonly published: Array<{ channel: string; message: string }> = [];

  client(): FakeRedisClient {
    return new FakeRedisClient(this);
  }

  subscribe(channel: string, subscriber: FakeSubscriber): void {
    let set = this.subscribers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(subscriber);
  }

  drop(subscriber: FakeSubscriber): void {
    for (const set of this.subscribers.values()) set.delete(subscriber);
  }

  publish(channel: string, message: string): number {
    this.published.push({ channel, message });
    const set = [...(this.subscribers.get(channel) ?? [])];
    for (const subscriber of set) setImmediate(() => subscriber.deliver(channel, message));
    return set.length;
  }
}

export class FakeRedisClient {
  constructor(private readonly redis: FakeRedis) {}

  async call(command: string, ...args: Array<string | number>): Promise<unknown> {
    if (command === 'PUBLISH') return this.redis.publish(String(args[0]), String(args[1]));
    if (command === 'SET') {
      const [key, value] = args.map(String);
      const nx = args.map(String).includes('NX');
      if (nx && this.redis.keys.has(key as string)) return null;
      this.redis.keys.set(key as string, value as string);
      return 'OK';
    }
    throw new Error(`FakeRedis: unsupported command ${command}`);
  }

  duplicate(): FakeSubscriber {
    return new FakeSubscriber(this.redis);
  }
}

export class FakeSubscriber {
  private readonly listeners: Array<(channel: string, message: string) => void> = [];
  closed = false;

  constructor(private readonly redis: FakeRedis) {}

  async subscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) this.redis.subscribe(channel, this);
    return channels.length;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'message') {
      this.listeners.push(listener as unknown as (channel: string, message: string) => void);
    }
    return this;
  }

  deliver(channel: string, message: string): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener(channel, message);
  }

  disconnect(): void {
    this.closed = true;
    this.redis.drop(this);
  }
}
