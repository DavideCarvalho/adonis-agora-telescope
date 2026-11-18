import { describe, expect, it } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import {
  canIngest,
  canRelayFor,
  capabilityAllows,
  relayScope,
  sharedSecretVerifier,
} from '../../src/topology/verify.js';

describe('capabilityAllows', () => {
  it('matches exact capabilities only when every segment is equal', () => {
    expect(capabilityAllows(['telescope:ingest'], 'telescope:ingest')).toBe(true);
    expect(capabilityAllows(['telescope:ingest'], 'telescope:ingest:relay')).toBe(false);
    expect(capabilityAllows(['telescope:ingest:relay'], 'telescope:ingest')).toBe(false);
    expect(capabilityAllows(['telescope:ingestx'], 'telescope:ingest')).toBe(false);
    expect(capabilityAllows([], 'telescope:ingest')).toBe(false);
  });

  it('a bare `*` matches everything', () => {
    expect(capabilityAllows(['*'], 'telescope:ingest')).toBe(true);
    expect(capabilityAllows(['*'], 'telescope:ingest:relay:shop')).toBe(true);
    expect(capabilityAllows(['*'], 'crypto:encrypt:orders')).toBe(true);
  });

  it('a trailing `*` matches zero or more further segments', () => {
    expect(capabilityAllows(['telescope:*'], 'telescope:ingest')).toBe(true);
    expect(capabilityAllows(['telescope:*'], 'telescope:ingest:relay:shop')).toBe(true);
    expect(capabilityAllows(['telescope:*'], 'crypto:encrypt')).toBe(false);
    expect(capabilityAllows(['telescope:ingest:*'], 'telescope:ingest:relay')).toBe(true);
    expect(capabilityAllows(['telescope:ingest:*'], 'telescope:ingest:relay:shop')).toBe(true);
  });

  it('a trailing `*` also matches zero further segments', () => {
    expect(capabilityAllows(['telescope:ingest:*'], 'telescope:ingest')).toBe(true);
    expect(capabilityAllows(['telescope:*'], 'telescope')).toBe(true);
    expect(capabilityAllows(['telescope:ingest:relay:*'], 'telescope:ingest:relay')).toBe(true);
    // Zero further segments, not fewer: the segments before the `*` must still be there.
    expect(capabilityAllows(['telescope:ingest:*'], 'telescope')).toBe(false);
    expect(capabilityAllows(['telescope:*:relay'], 'telescope')).toBe(false);
  });

  it('a `*` in the middle matches exactly one segment', () => {
    expect(capabilityAllows(['telescope:*:relay'], 'telescope:ingest:relay')).toBe(true);
    expect(capabilityAllows(['telescope:*:relay'], 'telescope:ingest:relay:shop')).toBe(false);
    expect(capabilityAllows(['telescope:*:relay:shop'], 'telescope:ingest:relay:shop')).toBe(true);
    expect(capabilityAllows(['telescope:*:relay:shop'], 'telescope:ingest:relay:billing')).toBe(
      false,
    );
  });

  it('ignores empty and non-string grants', () => {
    expect(capabilityAllows(['', 'telescope:read'], 'telescope:ingest')).toBe(false);
    expect(capabilityAllows([42, null, undefined] as unknown as string[], 'telescope:ingest')).toBe(
      false,
    );
    expect(capabilityAllows([42, '*'] as unknown as string[], 'telescope:ingest')).toBe(true);
  });
});

describe('ingest and relay capabilities', () => {
  it('`*` is accepted for ingest and relays for every app', () => {
    expect(canIngest(['*'])).toBe(true);
    expect(relayScope(['*'])).toBe('*');
  });

  it('wildcards over the relay capability relay for every app', () => {
    for (const grant of [
      'telescope:ingest:relay',
      'telescope:ingest:relay:*',
      'telescope:ingest:*',
      'telescope:*',
    ]) {
      expect(relayScope([grant]), grant).toBe('*');
      expect(canIngest([grant]), grant).toBe(true);
    }
  });

  it('a relay scoped to one app does not relay for another', () => {
    const scope = relayScope(['telescope:ingest:relay:a']);
    expect(scope).toEqual(['a']);
    expect(canRelayFor(scope, 'a')).toBe(true);
    expect(canRelayFor(scope, 'b')).toBe(false);
    expect(canIngest(['telescope:ingest:relay:a'])).toBe(true);
  });

  it('refuses unrelated capabilities', () => {
    for (const grant of ['telescope:read', 'crypto:*', 'telescope:ingestx', 'ingest', '']) {
      expect(canIngest([grant]), grant).toBe(false);
      expect(relayScope([grant]), grant).toBe(null);
    }
    // Plain ingest does not grant relaying.
    expect(relayScope(['telescope:ingest'])).toBe(null);
  });

  it('the server accepts a `*` token and lets it relay', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: sharedSecretVerifier({
        partitions: {
          root: { secret: 'root-secret', capabilities: ['*'] },
          scoped: { secret: 'scoped-secret', capabilities: ['telescope:ingest:relay:a'] },
          stranger: { secret: 'stranger-secret', capabilities: ['telescope:read'] },
        },
      }),
      store: () => store,
    });
    const entry = (id: string, tags: string[] = []) => ({
      id,
      type: 'log',
      familyHash: null,
      content: { message: id },
      tags,
      durationMs: null,
      origin: 'http',
      traceId: 't-1',
      createdAt: new Date().toISOString(),
    });

    const root = await handler.ingest({
      token: 'root-secret',
      app: 'root',
      body: { version: 1, entries: [entry('own'), entry('relayed', ['app:shop'])] },
    });
    expect(root.status).toBe(202);
    expect(root.body).toMatchObject({ accepted: 2, rejected: 0 });

    const scoped = await handler.ingest({
      token: 'scoped-secret',
      app: 'scoped',
      body: { version: 1, entries: [entry('to-a', ['app:a']), entry('to-b', ['app:b'])] },
    });
    expect(scoped.body).toMatchObject({ accepted: 1, rejected: 1 });

    const stranger = await handler.ingest({
      token: 'stranger-secret',
      app: 'stranger',
      body: { version: 1, entries: [entry('x')] },
    });
    expect(stranger.status).toBe(403);

    expect((await store.list()).map((r) => r.id).sort()).toEqual([
      'root:own',
      'root~shop:relayed',
      'scoped~a:to-a',
    ]);
    expect((await handler.whoami({ token: 'root-secret', app: 'root' })).body).toEqual({
      partition: 'root',
      relay: '*',
    });
  });
});

describe('capabilityAllows: a `*` before the last one consumes a segment', () => {
  it('does not let a non-trailing `*` run past the end of the required capability', () => {
    expect(capabilityAllows(['telescope:*:*'], 'telescope')).toBe(false);
    expect(capabilityAllows(['telescope:*:*:*'], 'telescope:a')).toBe(false);
    expect(capabilityAllows(['telescope:*:*'], 'telescope:a')).toBe(true);
    expect(capabilityAllows(['telescope:*:*'], 'telescope:a:b')).toBe(true);
    expect(capabilityAllows(['telescope:*'], 'telescope')).toBe(true);
  });
});
