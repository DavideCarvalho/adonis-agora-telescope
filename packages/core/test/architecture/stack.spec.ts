import { describe, expect, it } from 'vitest';
import {
  describeStack,
  describeStackUse,
  normalizeStack,
  STACK_DESCRIPTOR,
} from '../../src/fleet/stack.js';

function configOf(all: Record<string, unknown>) {
  return { get: (key: string) => all[key], all: () => all };
}

const database = {
  connection: 'hub',
  connections: {
    hub: { client: 'pg', connection: { host: 'pg.internal', port: 5432, database: 'educacao' } },
    identity: {
      client: 'pg',
      connection: { host: 'pg.internal', port: 5432, database: 'educacao' },
    },
    lite: { client: 'better-sqlite3', connection: { filename: 'tmp/db.sqlite3' } },
  },
};
const redis = {
  connection: 'main',
  connections: {
    main: { host: 'redis.internal', port: 6379, db: 0 },
    bus: { host: 'redis.internal', port: 6379, db: 1 },
  },
};

describe('describeStack', () => {
  it('reads databases and Redis; same server, one entry; the default connection is the app', () => {
    const stack = describeStack(configOf({ database, redis }));
    const pg = stack.filter((e) => e.tech === 'postgres');
    expect(pg).toHaveLength(1);
    expect(pg[0]).toMatchObject({ label: 'educacao', uses: ['app'] });
    expect(pg[0]?.id).toMatch(/^postgres:[a-f0-9]{10}$/);
    expect(
      stack
        .filter((e) => e.tech === 'redis')
        .map((e) => e.label)
        .sort(),
    ).toEqual(['bus', 'main']);
    expect(stack.some((e) => e.tech === 'sqlite')).toBe(true);
  });

  it('never sends credentials or hosts', () => {
    const json = JSON.stringify(
      describeStack(
        configOf({
          database: {
            connection: 'x',
            connections: {
              x: { client: 'pg', connection: 'postgres://user:s3cret@pg.internal:5432/app' },
            },
          },
        }),
      ),
    );
    expect(json).not.toMatch(/s3cret|pg\.internal|user/);
    expect(json).toMatch(/"label":"app"/);
  });

  it('plain connection fields and lib descriptors say what uses what', () => {
    const lucidStore = describeStackUse(async () => ({}), {
      tech: 'postgres',
      connection: 'hub',
      purpose: 'run history',
    });
    const disk = describeStackUse(async () => ({}), {
      tech: 's3',
      label: 'hub-avatars',
      host: 's3.example.com',
      purpose: 'avatars',
    });
    const stack = describeStack(
      configOf({
        database,
        redis,
        durable: { stores: { lucid: lucidStore }, controlPlane: { connection: 'main' } },
        media: { disks: { avatars: disk } },
        lock: { stores: { redis: { connectionName: 'main' } } },
      }),
    );
    const pg = stack.find((e) => e.tech === 'postgres');
    expect(pg?.uses).toEqual(['app', 'durable: run history']);
    expect(stack.find((e) => e.label === 'main')?.uses).toEqual(['durable', 'lock']);
    expect(stack.find((e) => e.tech === 's3')).toMatchObject({
      label: 'hub-avatars',
      uses: ['media: avatars'],
    });
  });

  it('a broken config contributes nothing', () => {
    const throwing = {
      get: () => {
        throw new Error('nope');
      },
      all: () => {
        throw new Error('nope');
      },
    };
    expect(describeStack(throwing)).toEqual([]);
  });

  it('the descriptor is non-enumerable', () => {
    const fn = describeStackUse(() => {}, { tech: 'redis' });
    expect(Object.keys(fn)).toEqual([]);
    expect((fn as unknown as Record<symbol, unknown>)[STACK_DESCRIPTOR]).toEqual([
      { tech: 'redis' },
    ]);
  });
});

describe('normalizeStack', () => {
  it('keeps valid entries, bounds the rest', () => {
    expect(
      normalizeStack([
        { id: 'postgres:abcdef1234', tech: 'postgres', label: 'educacao', uses: ['app', 1] },
        { id: 'bad id', tech: 'postgres' },
        'nope',
      ]),
    ).toEqual([{ id: 'postgres:abcdef1234', tech: 'postgres', label: 'educacao', uses: ['app'] }]);
    expect(normalizeStack(undefined)).toBeUndefined();
  });
});
