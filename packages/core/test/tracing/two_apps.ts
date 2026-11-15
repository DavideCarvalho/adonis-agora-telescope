import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppFactory } from '@adonisjs/core/factories/app';
import { ServerFactory } from '@adonisjs/core/factories/http';
import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import type { Entry, RecordInput } from '../../src/entry.js';
import type { TelescopeStore } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import TelescopeMiddleware from '../../src/telescope_middleware.js';

/**
 * Real AdonisJS HTTP servers, in this process, each running telescope's middleware. They share one
 * telescope runtime (a process has one), so the store tags every entry with the app recording it,
 * `app:<name>`, the way a central server does for its tenants.
 */

const currentApp = new AsyncLocalStorage<string>();

/** A store that tags entries `app:<name>` of the app handling the request, like a control plane. */
export class AppTaggingStore extends InMemoryTelescopeStore {
  override record<T>(input: RecordInput<T>): Promise<Entry<T>> {
    const app = currentApp.getStore();
    if (app === undefined) return super.record(input);
    return super.record({ ...input, tags: [...(input.tags ?? []), `app:${app}`] });
  }
}

/** The handler of a route: an Adonis `HttpContext`. */
export type Route = (ctx: HttpContext) => unknown;

export interface RunningApp {
  name: string;
  url: string;
  close(): Promise<void>;
}

/** Boot an Adonis server named `name` with `routes`, behind telescope's middleware. */
export async function startApp(name: string, routes: Record<string, Route>): Promise<RunningApp> {
  const app = new AppFactory().create(new URL('./', import.meta.url));
  await app.init();
  const server = new ServerFactory().merge({ app }).create();
  class AppMiddleware {
    handle(_ctx: HttpContext, next: NextFn) {
      return currentApp.run(name, () => next());
    }
  }
  server.use([
    async () => ({ default: AppMiddleware }),
    async () => ({ default: TelescopeMiddleware }),
  ]);
  const router = server.getRouter();
  for (const [pattern, handler] of Object.entries(routes)) router.get(pattern, handler);
  await server.boot();
  const http: Server = createServer((req, res) => {
    void server.handle(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    name,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** Let fire-and-forget records settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The `request` entries for `url` in `store`. */
export async function requestsTo(store: TelescopeStore, url: string): Promise<Entry[]> {
  return (await store.list({})).filter(
    (e) => e.type === 'request' && (e.content as { url?: string }).url === url,
  );
}

/** An entry's content as a record (empty for a missing entry). */
export function contentOf(entry: Entry | undefined): Record<string, unknown> {
  return (entry?.content ?? {}) as Record<string, unknown>;
}
