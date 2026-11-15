import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { RemoteTelescopeStore } from '../../src/topology/remote_store.js';
import { whoami } from '../../src/topology/status.js';
import { TELESCOPE_RESOURCE } from '../../src/topology/verify.js';

const servers: Server[] = [];
const stores: RemoteTelescopeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.stop();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const base = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return base(server);
}

/**
 * An in-memory OIDC issuer (discovery, JWKS, `client_credentials` token endpoint) minting
 * service-tenant tokens: one client per app, with the claims an authkit server puts in them.
 */
async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const clients: Record<string, { secret: string; claims: Record<string, unknown>; aud?: string }> =
    {
      shop: {
        secret: 'shop-client-secret',
        claims: {
          partition: 'shop',
          environment: 'production',
          capabilities: ['telescope:ingest'],
        },
      },
      billing: {
        secret: 'billing-client-secret',
        claims: { partition: 'billing', capabilities: ['telescope:ingest'] },
      },
      // A client of another product: the right issuer, the wrong resource.
      flags: {
        secret: 'flags-client-secret',
        claims: { partition: 'shop', capabilities: ['telescope:ingest'] },
        aud: 'urn:agora:flags',
      },
      // The right resource, without the ingest capability.
      viewer: {
        secret: 'viewer-client-secret',
        claims: { partition: 'shop', capabilities: ['telescope:read'] },
      },
    };
  let url = '';
  const mint = (clientId: string) => {
    const client = clients[clientId];
    if (client === undefined) throw new Error('unknown client');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ client_id: clientId, ...client.claims })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'k1' })
      .setIssuer(url)
      .setAudience(client.aud ?? TELESCOPE_RESOURCE)
      .setSubject(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(privateKey);
  };
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/oauth2/token`,
          jwks_uri: `${url}/jwks`,
        }),
      );
      return;
    }
    if (req.url === '/jwks') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === '/oauth2/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const basic = req.headers.authorization?.replace(/^Basic\s+/i, '');
        const [id, secret] = basic
          ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent)
          : [form.get('client_id'), form.get('client_secret')];
        const client = id ? clients[id] : undefined;
        if (!id || client === undefined || client.secret !== secret) {
          res
            .writeHead(401, { 'content-type': 'application/json' })
            .end('{"error":"invalid_client"}');
          return;
        }
        void mint(id).then((token) =>
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 600 })),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  url = await listen(server);
  return { url, mint };
}

/** The telescope server: the ingest handler behind a real HTTP listener. */
async function telescopeServer(issuerUrl: string) {
  const store = new InMemoryTelescopeStore();
  const handler = createIngestHandler({
    verifyTenant: authkitTenantVerifier({ issuer: issuerUrl, resource: TELESCOPE_RESOURCE }),
    store: () => store,
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const app = req.headers['x-telescope-app'] as string | undefined;
      const answer =
        req.url === '/_telescope/v1/ingest' && req.method === 'POST'
          ? await handler.ingest({ token, app, body: raw ? JSON.parse(raw) : null })
          : req.url === '/_telescope/v1/whoami'
            ? await handler.whoami({ token, app })
            : { status: 404, body: {} };
      res
        .writeHead(answer.status, { 'content-type': 'application/json' })
        .end(JSON.stringify(answer.body));
    });
  });
  return { url: await listen(server), store };
}

function app(url: string, issuerUrl: string, clientId: string, partition = clientId) {
  const store = new RemoteTelescopeStore({
    url,
    partition,
    token: authkitTenantToken({
      issuer: issuerUrl,
      clientId,
      clientSecret: `${clientId}-client-secret`,
      resource: TELESCOPE_RESOURCE,
    }),
    buffer: { flushIntervalMs: 60_000 },
  });
  stores.push(store);
  return store;
}

describe('remote path: authkit issuer, two apps, one server', () => {
  it('each app sends with its own token and its entries are tagged with the app from the token', async () => {
    const auth = await issuer();
    const central = await telescopeServer(auth.url);
    const shop = app(central.url, auth.url, 'shop');
    const billing = app(central.url, auth.url, 'billing');
    await shop.record({ type: 'request', content: { url: '/cart' }, tags: [] });
    await billing.record({ type: 'exception', content: { message: 'card declined' }, tags: [] });
    await shop.flush();
    await billing.flush();
    expect(shop.stats()).toMatchObject({ sent: 1, failures: 0 });
    expect(billing.stats()).toMatchObject({ sent: 1, failures: 0 });

    const rows = await central.store.list();
    expect(rows.find((r) => r.type === 'request')?.tags).toEqual(['app:shop', 'env:production']);
    expect(rows.find((r) => r.type === 'exception')?.tags).toEqual(['app:billing']);
    expect(await central.store.list({ tag: 'app:shop' })).toHaveLength(1);

    expect(
      await whoami({
        url: central.url,
        partition: 'shop',
        token: authkitTenantToken({
          issuer: auth.url,
          clientId: 'shop',
          clientSecret: 'shop-client-secret',
          resource: TELESCOPE_RESOURCE,
        }),
      }),
    ).toMatchObject({ status: 'ok', partition: 'shop', environment: 'production' });
  });

  it('an app claiming another name is still tagged with the name in its token', async () => {
    const auth = await issuer();
    const central = await telescopeServer(auth.url);
    const liar = app(central.url, auth.url, 'billing', 'shop');
    await liar.record({ type: 'log', content: {}, tags: ['app:shop'] });
    await liar.flush();
    expect((await central.store.list())[0]?.tags).toEqual(['app:billing']);
  });

  it('a token for another resource (401) or without telescope:ingest (403) stores nothing', async () => {
    const auth = await issuer();
    const central = await telescopeServer(auth.url);
    const wrongResource = new RemoteTelescopeStore({
      url: central.url,
      partition: 'shop',
      token: () => auth.mint('flags'),
      buffer: { flushIntervalMs: 60_000 },
    });
    stores.push(wrongResource);
    await wrongResource.record({ type: 'log', content: {} });
    await wrongResource.flush();
    expect(wrongResource.stats()).toMatchObject({
      lastError: 'the server answered 401',
      buffered: 1,
    });

    const viewer = new RemoteTelescopeStore({
      url: central.url,
      partition: 'shop',
      token: () => auth.mint('viewer'),
      buffer: { flushIntervalMs: 60_000 },
    });
    stores.push(viewer);
    await viewer.record({ type: 'log', content: {} });
    await viewer.flush();
    expect(viewer.stats()).toMatchObject({ lastError: 'the server answered 403', buffered: 1 });
    expect(await central.store.count()).toBe(0);
  });

  it('entries recorded while the server is down arrive once it is back', async () => {
    const auth = await issuer();
    // Reserve a port, then close it: the "server is down" phase.
    const probe = createServer();
    const url = await listen(probe);
    servers.splice(servers.indexOf(probe), 1);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const shop = app(url, auth.url, 'shop');
    await shop.record({ type: 'log', content: { n: 1 } });
    await shop.flush();
    expect(shop.stats()).toMatchObject({ buffered: 1, failures: 1 });
    // The server comes back on that port.
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: authkitTenantVerifier({ issuer: auth.url, resource: TELESCOPE_RESOURCE }),
      store: () => store,
    });
    const port = Number(new URL(url).port);
    const back = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', async () => {
        const answer = await handler.ingest({
          token: req.headers.authorization?.replace(/^Bearer\s+/i, ''),
          body: JSON.parse(raw),
        });
        res.writeHead(answer.status).end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => back.listen(port, '127.0.0.1', () => resolve()));
    servers.push(back);
    await shop.flush();
    expect(shop.stats()).toMatchObject({ buffered: 0, sent: 1, failures: 0 });
    expect((await store.list())[0]?.tags).toEqual(['app:shop', 'env:production']);
  });
});
