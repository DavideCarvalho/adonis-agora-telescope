import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDiscovery } from '../../src/discovery/config.js';
import { type RunningDiscovery, startDiscovery } from '../../src/discovery/index.js';
import { DiscoveryError } from '../../src/discovery/rewrite.js';
import { resolveTopology } from '../../src/topology/config.js';

/**
 * The default (no `strict`): a single-label host that names no app, a Docker Compose service such
 * as `http://minio:9000`, goes out exactly as written. An interceptor installed below discovery
 * records the origin each call reaches and answers it, so nothing touches DNS.
 */

const slot = globalThis as unknown as Record<symbol, { compose(i: unknown): unknown } | undefined>;
const KEYS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
const reached: string[] = [];
let originals: unknown[];
let discovery: RunningDiscovery | null;

class Answered extends Error {}

beforeAll(async () => {
  await fetch('data:,').catch(() => undefined);
  originals = KEYS.map((key) => slot[key]);
  const recorder =
    () =>
    (opts: { origin?: unknown; path?: unknown }, handler: Record<string, unknown>): boolean => {
      reached.push(`${String(opts.origin)}${String(opts.path)}`);
      const error = new Answered('answered by the test');
      if (typeof handler.onResponseError === 'function') handler.onResponseError(null, error);
      else (handler.onError as (e: unknown) => void)?.(error);
      return true;
    };
  for (const key of KEYS) {
    const current = slot[key];
    if (current !== undefined) slot[key] = current.compose(recorder) as never;
  }
  discovery = await startDiscovery({
    config: resolveDiscovery({ billing: 'http://127.0.0.1:3334', nodeHttp: true }),
    topology: resolveTopology({}),
  });
});

afterAll(async () => {
  await discovery?.stop();
  KEYS.forEach((key, i) => {
    slot[key] = originals[i] as never;
  });
});

async function causeOf(url: string): Promise<unknown> {
  return fetch(url).then(
    () => undefined,
    (error: Error) => error.cause,
  );
}

describe('discovery default: unknown single-label hosts pass through', () => {
  it('fetch to a Compose service goes out as written, no error from discovery', async () => {
    reached.length = 0;
    const cause = await causeOf('http://minio:9000/bucket/key');
    expect(cause).toBeInstanceOf(Answered);
    expect(reached).toContain('http://minio:9000/bucket/key');
  });

  it('a known app is still rewritten', async () => {
    reached.length = 0;
    await causeOf('http://billing/invoices/1');
    expect(reached).toContain('http://127.0.0.1:3334/invoices/1');
  });

  it('http.request to an unknown single-label host is not failed by discovery', async () => {
    const error = await new Promise<unknown>((resolve) => {
      http
        .get('http://languagetool:8010/v2/check', {
          lookup: (_h, _o, cb) => cb(new Answered('dns'), '', 4),
        })
        .on('error', resolve);
    });
    expect(error).not.toBeInstanceOf(DiscoveryError);
  });
});
