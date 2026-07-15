import { describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { MCP_METHOD_NOT_FOUND, MCP_UNAUTHORIZED, TelescopeMcpServer } from '../src/mcp/server.js';
import { MetricsService } from '../src/metrics/metrics_service.js';
import { TelescopeService } from '../src/service.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

async function build() {
  const store = new InMemoryTelescopeStore();
  const service = new TelescopeService(store);
  const metrics = new MetricsService(store);
  const server = new TelescopeMcpServer(service, metrics);
  return { store, service, metrics, server };
}

const req = (method: string, params?: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

type RpcResult = { result?: unknown; error?: { code: number; message: string } };

/** Pull the text payload out of a `tools/call` content envelope, parsed as JSON. */
function callPayload(res: RpcResult): any {
  const content = (res.result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? '{}');
}

describe('TelescopeMcpServer', () => {
  it('tools/list returns the full catalogue', async () => {
    const { server } = await build();
    const res = (await server.handle(req('tools/list'), true)) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual([
      'list_entries',
      'get_entry',
      'get_trace',
      'get_waterfall',
      'get_health',
      'diagnose_exception',
    ]);
  });

  it('tools/list only advertises the enabled subset', async () => {
    const store = new InMemoryTelescopeStore();
    const server = new TelescopeMcpServer(new TelescopeService(store), new MetricsService(store), {
      tools: new Set(['list_entries', 'get_health'] as const),
    });
    const res = (await server.handle(req('tools/list'), true)) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['list_entries', 'get_health']);
  });

  it('list_entries returns slimmed request entries, filtered by type', async () => {
    const { store, server } = await build();
    await store.record({
      type: EntryType.Request,
      content: { method: 'GET', url: '/x', status: 200 },
      tags: ['status:200'],
      traceId: 't1',
    });
    await store.record({
      type: EntryType.Diagnostic,
      content: { event: 'noise' },
      traceId: 't1',
    });

    const res = (await server.handle(
      req('tools/call', { name: 'list_entries', arguments: { type: 'request' } }),
      true,
    )) as RpcResult;
    const payload = callPayload(res);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].type).toBe('request');
    expect(payload.entries[0].summary).toBe('GET /x → 200');
  });

  it('get_health returns the Pulse summary', async () => {
    const { store, server } = await build();
    await store.record({
      type: EntryType.Request,
      content: { method: 'GET', url: '/x', status: 200 },
      durationMs: 5,
      traceId: 't1',
    });
    const res = (await server.handle(
      req('tools/call', { name: 'get_health', arguments: {} }),
      true,
    )) as RpcResult;
    const payload = callPayload(res);
    expect(payload).toHaveProperty('windowMs');
    expect(payload).toHaveProperty('throughput');
    expect(payload.counts.request).toBe(1);
  });

  it('get_trace returns every entry recorded under a trace id', async () => {
    const { store, server } = await build();
    await store.record({ type: EntryType.Request, content: {}, traceId: 'trace-9' });
    await store.record({ type: EntryType.Diagnostic, content: {}, traceId: 'trace-9' });
    await store.record({ type: EntryType.Diagnostic, content: {}, traceId: 'other' });

    const res = (await server.handle(
      req('tools/call', { name: 'get_trace', arguments: { traceId: 'trace-9' } }),
      true,
    )) as RpcResult;
    const payload = callPayload(res);
    expect(payload.entries).toHaveLength(2);
  });

  it('unknown tool surfaces a JSON-RPC internal error', async () => {
    const { server } = await build();
    const res = (await server.handle(
      req('tools/call', { name: 'nope', arguments: {} }),
      true,
    )) as RpcResult;
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/not enabled|unknown tool/i);
  });

  it('unknown method returns -32601', async () => {
    const { server } = await build();
    const res = (await server.handle(req('bogus'), true)) as RpcResult;
    expect(res.error?.code).toBe(MCP_METHOD_NOT_FOUND);
  });

  it('an unauthorized call is refused with -32001 regardless of method', async () => {
    const { server } = await build();
    const res = (await server.handle(req('tools/list'), false)) as RpcResult;
    expect(res.error?.code).toBe(MCP_UNAUTHORIZED);
    expect(res.result).toBeUndefined();
  });

  it('diagnose_exception reports when AI is not configured', async () => {
    const { store, server } = await build();
    await store.record({
      type: EntryType.Exception,
      content: { name: 'Err', message: 'boom' },
      traceId: 't1',
    });
    const id = (await store.list({}))[0]?.id;
    const res = (await server.handle(
      req('tools/call', { name: 'diagnose_exception', arguments: { id } }),
      true,
    )) as RpcResult;
    expect((res.result as { content: { text: string }[] }).content[0]?.text).toMatch(
      /not configured/i,
    );
  });

  it('diagnose_exception runs the hook when configured', async () => {
    const store = new InMemoryTelescopeStore();
    const server = new TelescopeMcpServer(new TelescopeService(store), new MetricsService(store), {
      diagnose: async () => '## Probable cause\nA null deref.',
    });
    await store.record({
      type: EntryType.Exception,
      content: { name: 'TypeError', message: 'x is undefined' },
      traceId: 't1',
    });
    const id = (await store.list({}))[0]?.id;
    const res = (await server.handle(
      req('tools/call', { name: 'diagnose_exception', arguments: { id } }),
      true,
    )) as RpcResult;
    expect((res.result as { content: { text: string }[] }).content[0]?.text).toMatch(
      /Probable cause/,
    );
  });

  it('notifications resolve to null (no response body)', async () => {
    const { server } = await build();
    const res = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
    expect(res).toBeNull();
  });
});
