import { describe, expect, it, vi } from 'vitest';
import type { ExceptionEntryContent } from '../../src/ai/diagnoser.js';
import { DiagnosisCoordinator } from '../../src/ai/diagnosis_coordinator.js';
import {
  type AnthropicMessagesClient,
  TelescopeAiDiagnoser,
} from '../../src/ai/telescope_ai_diagnoser.js';
import {
  type AlertChannel,
  type AlertPayload,
  Alerter,
  type ResolvedAlerts,
  formatSlackMessage,
} from '../../src/alerts/index.js';
import type { Entry } from '../../src/entry.js';
import { EntryType } from '../../src/entry.js';
import { TelescopeMcpServer } from '../../src/mcp/server.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

const VALID_JSON = JSON.stringify({
  cause: 'A null user was dereferenced in the checkout handler.',
  fix: 'Guard against a missing user before accessing it.',
  confidence: 'high',
});

/** A configured coordinator over a real diagnoser + fake Anthropic client. */
function configuredCoordinator(text = VALID_JSON): {
  coordinator: DiagnosisCoordinator;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text }] }));
  const client: AnthropicMessagesClient = { messages: { create } };
  const diagnoser = new TelescopeAiDiagnoser({
    client,
    model: 'claude-sonnet-4-6',
    maxTokens: 512,
  });
  return { coordinator: new DiagnosisCoordinator({ diagnoser }), create };
}

/** The exact hook the MCP provider builds from a configured coordinator. */
function mcpHook(coordinator: DiagnosisCoordinator, service: TelescopeService) {
  return async (entry: Entry) => {
    const related = entry.traceId !== null ? await service.byTrace(entry.traceId) : undefined;
    return coordinator.diagnoseMarkdown(entry as Entry<ExceptionEntryContent>, {
      ...(related !== undefined ? { related } : {}),
    });
  };
}

// ─── MCP diagnose_exception ────────────────────────────────────────────────

describe('MCP diagnose_exception ← coordinator', () => {
  async function seedException(store: InMemoryTelescopeStore): Promise<string> {
    await store.record({
      type: EntryType.Exception,
      content: { name: 'TypeError', message: 'x is undefined' },
      traceId: 't1',
    });
    return (await store.list({}))[0]?.id as string;
  }

  it('returns the real diagnosis when the coordinator is configured', async () => {
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    const { coordinator, create } = configuredCoordinator();
    const server = new TelescopeMcpServer(service, new MetricsService(store), {
      diagnose: mcpHook(coordinator, service),
    });

    const id = await seedException(store);
    const res = (await server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'diagnose_exception', arguments: { id } },
      },
      true,
    )) as { result: { content: { text: string }[] } };

    const text = res.result.content[0]?.text ?? '';
    expect(text).toContain('Probable cause');
    expect(text).toContain('A null user was dereferenced');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports not configured when no coordinator hook is wired (unchanged behaviour)', async () => {
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    // The provider passes NO `diagnose` when the coordinator is absent / inert.
    const server = new TelescopeMcpServer(service, new MetricsService(store));
    const id = await seedException(store);
    const res = (await server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'diagnose_exception', arguments: { id } },
      },
      true,
    )) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]?.text).toMatch(/not configured/i);
  });

  it('an inert coordinator (diagnoser: null) produces no hook → not configured', async () => {
    const inert = new DiagnosisCoordinator({ diagnoser: null });
    expect(inert.isConfigured()).toBe(false);
    // Provider would pass undefined; assert the guard the provider uses.
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    const diagnose = inert.isConfigured() ? mcpHook(inert, service) : undefined;
    const server = new TelescopeMcpServer(service, new MetricsService(store), {
      ...(diagnose !== undefined ? { diagnose } : {}),
    });
    const id = await seedException(store);
    const res = (await server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'diagnose_exception', arguments: { id } },
      },
      true,
    )) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]?.text).toMatch(/not configured/i);
  });
});

// ─── Alerter "Probable cause (AI)" section ─────────────────────────────────

function exceptionEntry(familyHash: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `ex-${Math.random().toString(36).slice(2)}`,
    type: 'exception',
    familyHash,
    content: {
      name: 'TypeError',
      message: 'cannot read x',
      stack: 'TypeError: cannot read x\n  at a',
      method: 'POST',
      url: '/checkout',
      traceId: null,
    },
    tags: ['user:42'],
    sequence: 1,
    durationMs: null,
    origin: 'http',
    traceId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function capturingChannel(name = 'capture'): { channel: AlertChannel; payloads: AlertPayload[] } {
  const payloads: AlertPayload[] = [];
  return {
    payloads,
    channel: {
      name,
      send(alert) {
        payloads.push(alert);
        return Promise.resolve();
      },
    },
  };
}

function resolved(overrides: Partial<ResolvedAlerts> = {}): ResolvedAlerts {
  return {
    enabled: true,
    channels: [],
    dashboardUrl: null,
    intervalMs: 1_000,
    cooldownMs: 900_000,
    instanceId: 'host-1',
    rules: [{ type: 'new-exception', window: '1h' }],
    ...overrides,
  };
}

describe('Alerter new-exception ← coordinator diagnosis', () => {
  it('attaches a probable-cause summary to the payload when configured', async () => {
    const { channel, payloads } = capturingChannel();
    const { coordinator } = configuredCoordinator();
    const alerter = new Alerter({
      alerts: resolved({ channels: [channel] }),
      diagnose: (entry) => coordinator.diagnoseSummary(entry as Entry<ExceptionEntryContent>),
    });

    await alerter.evaluate([exceptionEntry('fam-A')]);

    expect(payloads).toHaveLength(1);
    const diagnosis = payloads[0]?.diagnosis;
    expect(diagnosis).toBeDefined();
    expect(diagnosis?.confidence).toBe('high');
    expect(diagnosis?.cause).toContain('null user was dereferenced');

    // …and the Slack renderer surfaces a "Probable cause (AI)" section.
    const slack = formatSlackMessage(payloads[0] as AlertPayload);
    const rendered = JSON.stringify(slack.blocks);
    expect(rendered).toContain('Probable cause (AI)');
    expect(rendered).toContain('null user was dereferenced');
  });

  it('emits no diagnosis section when no diagnose hook is wired (unchanged behaviour)', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({ alerts: resolved({ channels: [channel] }) });

    await alerter.evaluate([exceptionEntry('fam-A')]);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.diagnosis).toBeUndefined();
    const slack = formatSlackMessage(payloads[0] as AlertPayload);
    expect(JSON.stringify(slack.blocks)).not.toContain('Probable cause (AI)');
  });

  it('a throwing diagnose hook is swallowed; the alert still fires without a section', async () => {
    const { channel, payloads } = capturingChannel();
    const logger = vi.fn();
    const alerter = new Alerter({
      alerts: resolved({ channels: [channel] }),
      diagnose: () => Promise.reject(new Error('diagnosis boom')),
      logger,
    });

    await expect(alerter.evaluate([exceptionEntry('fam-A')])).resolves.toBeUndefined();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.diagnosis).toBeUndefined();
    expect(logger).toHaveBeenCalled();
  });

  it('an inert coordinator yields no hook → alerts unchanged', async () => {
    const inert = new DiagnosisCoordinator({ diagnoser: null });
    const { channel, payloads } = capturingChannel();
    const diagnose = inert.isConfigured()
      ? (entry: Entry) => inert.diagnoseSummary(entry as Entry<ExceptionEntryContent>)
      : undefined;
    const alerter = new Alerter({
      alerts: resolved({ channels: [channel] }),
      ...(diagnose !== undefined ? { diagnose } : {}),
    });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads[0]?.diagnosis).toBeUndefined();
  });
});
