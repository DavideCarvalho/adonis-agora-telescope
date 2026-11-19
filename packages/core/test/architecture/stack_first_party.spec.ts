import * as cache from '@adonisjs/cache';
import * as drive from '@adonisjs/drive';
import * as limiter from '@adonisjs/limiter';
import * as lock from '@adonisjs/lock';
import * as mail from '@adonisjs/mail';
import * as queue from '@adonisjs/queue';
import * as session from '@adonisjs/session';
import * as transmit from '@adonisjs/transmit';
import { redis as transmitRedis } from '@adonisjs/transmit/transports/redis';
import { describe, expect, it } from 'vitest';
import { describeStack, type StackEntry } from '../../src/fleet/stack.js';
import { createIntrospector } from '../../src/fleet/stack_introspect.js';
import { storage } from '../../src/stores/factory.js';
import { transports } from '../../src/topology/transports/index.js';

function configOf(all: Record<string, unknown>) {
  return { get: (key: string) => all[key], all: () => all };
}

const database = {
  connection: 'pg',
  connections: {
    pg: { client: 'pg', connection: { host: 'pg.internal', port: 5432, database: 'app' } },
    telescope: {
      client: 'pg',
      connection: { host: 'pg.other', port: 5432, database: 'telescope' },
    },
  },
};
const redis = {
  connection: 'main',
  connections: {
    main: { host: 'redis.internal', port: 6379 },
    bus: { host: 'redis.internal', port: 6380 },
  },
};

function usesOf(stack: StackEntry[], tech: string, label?: string): string[] | undefined {
  return stack.find((e) => e.tech === tech && (label === undefined || e.label === label))?.uses;
}

describe('describeStack: AdonisJS first-party packages', () => {
  it('drive: each disk, the bucket as label, the endpoint only hashed', () => {
    const stack = describeStack(
      configOf({
        drive: drive.defineConfig({
          default: 's3',
          services: {
            fs: drive.services.fs({ location: '/srv/uploads', visibility: 'private' }),
            s3: drive.services.s3({
              credentials: { accessKeyId: 'AKIA-SECRET', secretAccessKey: 'shh-secret' },
              region: 'us-east-1',
              bucket: 'avatars',
              visibility: 'private',
            }),
            r2: drive.services.s3({
              credentials: { accessKeyId: 'AKIA-SECRET', secretAccessKey: 'shh-secret' },
              region: 'auto',
              bucket: 'backups',
              endpoint: 'https://user:pw@acct.r2.cloudflarestorage.com',
              visibility: 'private',
            }),
            gcs: drive.services.gcs({ bucket: 'reports', visibility: 'private' }),
          },
        }),
      }),
    );
    expect(usesOf(stack, 's3', 'avatars')).toEqual(['drive: disk s3']);
    expect(usesOf(stack, 'r2', 'backups')).toEqual(['drive: disk r2']);
    expect(usesOf(stack, 'gcs', 'reports')).toEqual(['drive: disk gcs']);
    // Not the default disk: a local folder is not drawn.
    expect(stack.some((e) => e.tech === 'fs')).toBe(false);
    expect(JSON.stringify(stack)).not.toMatch(/SECRET|secret|cloudflarestorage|user|pw@/);
  });

  it('drive: the default local disk is drawn', () => {
    const stack = describeStack(
      configOf({
        drive: drive.defineConfig({
          default: 'fs',
          services: { fs: drive.services.fs({ location: '/srv', visibility: 'private' }) },
        }),
      }),
    );
    expect(usesOf(stack, 'fs')).toEqual(['drive: disk fs']);
  });

  it('mail: each transport, an SMTP server by its vendor, never the key', () => {
    const stack = describeStack(
      configOf({
        mail: mail.defineConfig({
          default: 'smtp',
          mailers: {
            smtp: mail.transports.smtp({
              host: 'smtp.resend.com',
              port: 465,
              auth: { user: 'resend', pass: 're_secret', type: 'login' },
            }),
            resend: mail.transports.resend({ key: 're_secret', baseUrl: 'https://api.resend.com' }),
            ses: mail.transports.ses({ region: 'us-east-1' }),
            mailgun: mail.transports.mailgun({
              key: 'mg_secret',
              baseUrl: 'https://api.mailgun.net/v3',
              domain: 'mg.example.com',
            }),
            office: mail.transports.smtp({ host: 'mail.example.com', port: 587 }),
          },
        }),
      }),
    );
    expect(usesOf(stack, 'resend', 'smtp')).toEqual(['mail: mailer smtp']);
    expect(usesOf(stack, 'resend', 'resend')).toEqual(['mail: mailer resend']);
    expect(usesOf(stack, 'ses')).toEqual(['mail: mailer ses']);
    expect(usesOf(stack, 'mailgun')).toEqual(['mail: mailer mailgun']);
    expect(usesOf(stack, 'smtp', 'office')).toEqual(['mail: mailer office']);
    expect(JSON.stringify(stack)).not.toMatch(/secret|example\.com|api\.resend/);
  });

  it('cache: a Redis L2 and bus, a database L2; the memory L1 is nothing', () => {
    const stack = describeStack(
      configOf({
        database,
        redis,
        cache: cache.defineConfig({
          default: 'main',
          stores: {
            main: cache
              .store()
              .useL1Layer(cache.drivers.memory({ maxItems: 100 }))
              .useL2Layer(cache.drivers.redis({ connectionName: 'main' }))
              .useBus(cache.drivers.redisBus({ connectionName: 'bus' })),
            sql: cache.store().useL2Layer(cache.drivers.database({ connectionName: 'telescope' })),
            local: cache.store().useL1Layer(cache.drivers.memory({})),
          },
        }),
      }),
    );
    expect(usesOf(stack, 'redis', 'main')).toEqual(['cache: store main']);
    expect(usesOf(stack, 'redis', 'bus')).toEqual(['cache: store main (bus)']);
    expect(usesOf(stack, 'postgres', 'telescope')).toEqual(['cache: store sql']);
    expect(usesOf(stack, 'postgres', 'app')).toEqual(['app']);
  });

  it('lock, limiter, session, queue: the selected store, through its connection', () => {
    const stack = describeStack(
      configOf({
        database,
        redis,
        lock: lock.defineConfig({
          default: 'redis',
          stores: {
            redis: lock.stores.redis({ connectionName: 'bus' }),
            memory: lock.stores.memory(),
          },
        }),
        limiter: limiter.defineConfig({
          default: 'db',
          stores: {
            redis: limiter.stores.redis({ connectionName: 'bus' }),
            db: limiter.stores.database({ tableName: 'rate_limits' }),
          },
        }),
        session: session.defineConfig({
          store: 'redis',
          stores: {
            cookie: session.stores.cookie(),
            redis: session.stores.redis({ connection: 'main' }),
          },
        }),
        queue: queue.defineConfig({
          default: 'redis',
          adapters: { redis: queue.drivers.redis(), sync: queue.drivers.sync() },
          locations: [],
        }),
      }),
    );
    expect(usesOf(stack, 'redis', 'bus')).toEqual(['lock']);
    // `queue.drivers.redis()` without a connection: the default one.
    expect(usesOf(stack, 'redis', 'main')).toEqual(['queue', 'session']);
    // The database store without a connection: the primary one.
    expect(usesOf(stack, 'postgres', 'app')).toEqual(['app', 'limiter']);
  });

  it('a default that names no store selects none; a transport with no address is not drawn', () => {
    const stack = describeStack(
      configOf({
        redis,
        lock: { default: 'gone', stores: { redis: lock.stores.redis({ connectionName: 'main' }) } },
        transmit: transmit.defineConfig({
          transport: { driver: transmitRedis({ password: 'pw' }), channel: 'transmit' },
        }),
      }),
    );
    expect(stack.flatMap((e) => e.uses)).toEqual([]);
  });

  it('session: a cookie store uses nothing; a disabled session neither', () => {
    const cookie = describeStack(
      configOf({
        redis,
        session: session.defineConfig({
          store: 'cookie',
          stores: {
            cookie: session.stores.cookie(),
            redis: session.stores.redis({ connection: 'main' }),
          },
        }),
      }),
    );
    expect(cookie.flatMap((e) => e.uses)).toEqual([]);
    const off = describeStack(
      configOf({
        redis,
        session: session.defineConfig({
          enabled: false,
          store: 'redis',
          stores: { redis: session.stores.redis({ connection: 'main' }) },
        }),
      }),
    );
    expect(off.flatMap((e) => e.uses)).toEqual([]);
  });

  it('transmit: a Redis transport on a configured server is that connection', () => {
    const on = (port: number) =>
      describeStack(
        configOf({
          redis,
          transmit: transmit.defineConfig({
            pingInterval: '30s',
            transport: {
              driver: transmitRedis({ host: 'redis.internal', port, password: 'pw-secret' }),
              channel: 'transmit',
            },
          }),
        }),
      );
    expect(usesOf(on(6380), 'redis', 'bus')).toEqual(['transmit']);
    const elsewhere = on(7000);
    expect(usesOf(elsewhere, 'redis', 'transmit')).toEqual(['transmit']);
    expect(JSON.stringify(elsewhere)).not.toMatch(/secret|redis\.internal/);
  });

  it('telescope itself: the selected store and the Redis ingest stream', () => {
    const stack = describeStack(
      configOf({
        database,
        redis,
        telescope: {
          store: 'lucid',
          stores: {
            memory: storage.memory(),
            lucid: storage.lucid({ connection: 'telescope' }),
            other: storage.lucid({ connection: 'pg' }),
          },
          transport: transports.redis({ connection: 'bus' }),
        },
      }),
    );
    expect(usesOf(stack, 'postgres', 'telescope')).toEqual(['telescope: entries']);
    expect(usesOf(stack, 'postgres', 'app')).toEqual(['app']);
    expect(usesOf(stack, 'redis', 'bus')).toEqual(['telescope: ingest stream']);
  });

  it('telescope tiered: the hot connection and the cold bucket', () => {
    const stack = describeStack(
      configOf({
        database,
        telescope: {
          store: 'tiered',
          stores: {
            tiered: storage.tiered({
              hot: storage.lucid(),
              cold: storage.parquet({
                location: { s3: { client: { send: async () => ({}) }, bucket: 'telescope-cold' } },
              }),
              hotFor: '5m',
            }),
          },
        },
      }),
    );
    expect(usesOf(stack, 'postgres', 'app')).toEqual(['app', 'telescope: entries']);
    expect(usesOf(stack, 's3', 'telescope-cold')).toEqual(['telescope: cold tier']);
  });

  it('without introspection: only names that are technologies count', () => {
    const stack = describeStack(
      configOf({
        redis,
        lock: lock.defineConfig({ default: 'redis', stores: { redis: lock.stores.redis({}) } }),
        drive: drive.defineConfig({
          default: 's3',
          services: {
            s3: drive.services.s3({
              bucket: 'b',
              region: 'r',
              credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
              visibility: 'private',
            }),
          },
        }),
      }),
      { introspect: false },
    );
    expect(usesOf(stack, 'redis', 'main')).toEqual(['lock']);
    // The drive config is a closure: nothing to read, nothing guessed (a disk named `s3` only
    // counts when the config is readable and that one service is not, a custom factory).
    expect(stack.some((e) => e.tech === 's3')).toBe(false);
  });

  it('a custom disk or mailer factory counts by its name when that is a technology', () => {
    const stack = describeStack(
      configOf({
        drive: drive.defineConfig({
          default: 'r2',
          services: { r2: () => ({}) as never, assets: () => ({}) as never },
        }),
        mail: mail.defineConfig({
          default: 'postmark',
          mailers: { postmark: () => ({}) as never, internal: () => ({}) as never },
        }),
      }),
    );
    expect(stack.map((e) => [e.tech, e.uses])).toEqual([
      ['postmark', ['mail: mailer postmark']],
      ['r2', ['drive: disk r2']],
    ]);
  });

  it('a config that breaks the readers contributes nothing, and never throws', () => {
    const hostile = {
      type: 'provider',
      get resolver() {
        throw new Error('nope');
      },
    };
    const stack = describeStack(
      configOf({
        redis,
        drive: hostile,
        mail: { type: 'provider', resolver: () => {} },
        cache: {
          stores: {
            main: new Proxy(
              {},
              {
                get: () => {
                  throw new Error('nope');
                },
              },
            ),
          },
        },
        session: session.defineConfig({
          store: 'redis',
          stores: { redis: session.stores.redis({ connection: 'main' }) },
        }),
      }),
    );
    expect(usesOf(stack, 'redis', 'main')).toEqual(['session']);
  });

  it('a spent budget reads nothing', () => {
    const introspector = createIntrospector(-1);
    expect(introspector?.closure(() => redis)).toBeUndefined();
    introspector?.dispose();
    const stack = describeStack(
      configOf({
        redis,
        session: session.defineConfig({
          store: 'redis',
          stores: { redis: session.stores.redis({ connection: 'bus' }) },
        }),
      }),
      { budgetMs: -1 },
    );
    expect(stack.flatMap((e) => e.uses)).toEqual([]);
  });

  it('the introspector reads closures and private fields, and leaves no global behind', () => {
    const introspector = createIntrospector();
    expect(introspector).not.toBeNull();
    const secret = { connectionName: 'main' };
    function stores(config: unknown) {
      return () => config;
    }
    // The live value, not a copy; named after the function that made the closure.
    expect(introspector?.closure(stores(secret))).toEqual({
      names: ['stores'],
      vars: { config: secret },
    });
    expect(introspector?.closure(stores(secret))?.vars.config).toBe(secret);
    class Holder {
      #inner = 42;
      peek() {
        return this.#inner;
      }
    }
    expect(introspector?.privates(new Holder())).toEqual({ '#inner': 42 });
    introspector?.dispose();
    expect(introspector?.privates(new Holder())).toBeUndefined();
    expect(Object.getOwnPropertySymbols(globalThis).map(String)).not.toContain(
      'Symbol(@adonis-agora/telescope.introspect)',
    );
  });
});
