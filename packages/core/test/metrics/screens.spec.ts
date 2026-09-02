import { describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { summarizeScreens } from '../../src/metrics/screens.js';
import { classifyRequest } from '../../src/request_watcher.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

/** A request-like stub with the headers a classifier reads. */
function request(url: string, headers: Record<string, string> = {}) {
  return {
    method: () => 'GET',
    url: () => url,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

/**
 * The distinction the console could not make: a screen navigation and the dozen XHRs
 * that screen then fires are all `request` entries with a url, so "most visited
 * screens" and "busiest endpoints" were one list that answered neither question.
 */
describe('classifyRequest', () => {
  it('x-inertia é uma VISITA DE TELA, mesmo pedindo JSON', () => {
    // O caso que inverte a resposta ingênua: Inertia manda Accept: application/json
    // e mesmo assim é navegação. Ir pelo Accept classificaria toda tela como api.
    const req = request('/pesquisador/escrita', {
      'x-inertia': 'true',
      accept: 'application/json',
    });
    expect(classifyRequest(req)).toBe('page');
  });

  it('navegação de browser (Accept: text/html) é page', () => {
    expect(
      classifyRequest(request('/admin/dashboard', { accept: 'text/html,application/xhtml+xml' })),
    ).toBe('page');
  });

  it('resposta text/html é page mesmo sem Accept útil', () => {
    expect(classifyRequest(request('/boas-vindas', {}), 'text/html; charset=utf-8')).toBe('page');
  });

  it('fetch de dados é api', () => {
    expect(classifyRequest(request('/api/notifications', { accept: 'application/json' }))).toBe(
      'api',
    );
  });

  it('asset é decidido pela URL, antes de qualquer header', () => {
    // Um .css pedido com Accept: */* cairia em `api` e afogaria a lista de endpoints.
    expect(classifyRequest(request('/assets/app-a1b2.css', { accept: '*/*' }))).toBe('asset');
    expect(classifyRequest(request('/assets/app.js', { accept: 'text/html' }))).toBe('asset');
    expect(classifyRequest(request('/img/logo.png'))).toBe('asset');
  });

  it('a query string não engana a detecção de asset', () => {
    expect(classifyRequest(request('/assets/app.js?v=123'))).toBe('asset');
  });

  it('sem header nenhum, o default é api', () => {
    expect(classifyRequest(request('/qualquer/coisa'))).toBe('api');
  });
});

describe('summarizeScreens', () => {
  async function seed() {
    const store = new InMemoryTelescopeStore();
    const hit = (
      url: string,
      kind: 'page' | 'api',
      durationMs: number,
      status = 200,
      userId?: string,
    ) =>
      store.record({
        type: EntryType.Request,
        content: {
          method: 'GET',
          url,
          status,
          durationMs,
          traceId: null,
          kind,
          user: userId ? { id: userId } : null,
        },
        durationMs,
      });

    await hit('/escrita', 'page', 100, 200, 'ada');
    await hit('/escrita', 'page', 300, 200, 'ada');
    await hit('/escrita', 'page', 200, 500, 'grace');
    await hit('/api/notifications', 'api', 10, 200, 'ada');
    return store;
  }

  it('agrega contagem, média, máximo, erros e usuários distintos', async () => {
    const rows = summarizeScreens(await (await seed()).list({}));
    const escrita = rows.find((r) => r.url === '/escrita');
    expect(escrita).toMatchObject({
      count: 3,
      users: 2,
      avgMs: 200,
      maxMs: 300,
      errors: 1,
      kind: 'page',
    });
  });

  it('ordena por volume', async () => {
    const rows = summarizeScreens(await (await seed()).list({}));
    expect(rows[0]?.url).toBe('/escrita');
  });

  it('filtra por kind — é isso que separa telas de endpoints', async () => {
    const entries = await (await seed()).list({});
    expect(summarizeScreens(entries, { kind: 'page' }).map((r) => r.url)).toEqual(['/escrita']);
    expect(summarizeScreens(entries, { kind: 'api' }).map((r) => r.url)).toEqual([
      '/api/notifications',
    ]);
  });

  it('mesma url com kinds diferentes NÃO se funde', async () => {
    // /relatorios como visita e como recarga parcial do Inertia são perguntas
    // diferentes; somar as duas daria um número que não responde nenhuma delas.
    const store = new InMemoryTelescopeStore();
    for (const kind of ['page', 'api'] as const) {
      await store.record({
        type: EntryType.Request,
        content: {
          method: 'GET',
          url: '/relatorios',
          status: 200,
          durationMs: 5,
          traceId: null,
          kind,
          user: null,
        },
        durationMs: 5,
      });
    }
    expect(summarizeScreens(await store.list({}))).toHaveLength(2);
  });

  it('entry antiga sem kind conta como api em vez de sumir', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.Request,
      content: {
        method: 'GET',
        url: '/velha',
        status: 200,
        durationMs: 5,
        traceId: null,
        user: null,
      },
      durationMs: 5,
    });
    expect(summarizeScreens(await store.list({}))[0]).toMatchObject({
      url: '/velha',
      kind: 'api',
    });
  });

  it('ignora entries que não são request', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({ type: EntryType.Redis, content: { command: 'GET' } });
    expect(summarizeScreens(await store.list({}))).toEqual([]);
  });
});
