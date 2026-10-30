import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { AiRunRow, AiUsageSummary } from '../client/types.js';
import { AiSection, formatUsd } from './AiSection.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

const run: AiRunRow = {
  entryId: 'entry-1',
  traceId: 'trace-1',
  at: new Date().toISOString(),
  status: 'completed',
  agent: 'writer',
  runId: 'run-1',
  threadId: 'thread-1',
  modelId: 'claude-sonnet-4-5',
  durationMs: 4200,
  ttftMs: 900,
  queueMs: 150,
  modelMs: 3100,
  toolsMs: 800,
  steps: 2,
  modelCalls: 2,
  toolCalls: 2,
  inputTokens: 1200,
  outputTokens: 300,
  costUsd: 0.012,
  code: null,
  stepTimings: [
    {
      step: 0,
      modelMs: 1800,
      toolsMs: 800,
      tools: [{ toolName: 'search_articles', ms: 650 }],
    },
  ],
};

function summary(over: Partial<AiUsageSummary> = {}): AiUsageSummary {
  return {
    windowStart: '2026-10-29T00:00:00.000Z',
    windowEnd: '2026-10-29T12:00:00.000Z',
    spend: {
      totalUsd: 0.016,
      platformUsd: 0.004,
      estimatedUsd: 0.004,
      calls: 3,
      unpricedCalls: 1,
      inputTokens: 2400,
      outputTokens: 600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      audioSeconds: 90,
      byFeature: [
        {
          key: 'agent:writer',
          costUsd: 0.012,
          calls: 1,
          unpricedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
      byModel: [],
      byActor: [],
      buckets: [
        {
          start: '2026-10-29T00:00:00.000Z',
          costUsd: 0.016,
          platformUsd: 0.004,
          estimatedUsd: 0,
          calls: 3,
        },
      ],
    },
    runs: [run],
    slowest: [run],
    mostExpensive: [run],
    unpriced: [
      {
        feature: 'transcription',
        model: 'whisper-1',
        provider: 'openai',
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 90,
        characters: 0,
        lastAt: new Date().toISOString(),
      },
    ],
    coverage: {
      usageEvents: 3,
      runEvents: 1,
      agentEvents: 4,
      legacyAgentLib: false,
      runsWithoutTimings: 0,
    },
    truncated: false,
    ...over,
  };
}

function renderAi(data: AiUsageSummary, onOpenTrace = vi.fn()) {
  const client = { ai: vi.fn().mockResolvedValue(data) } as unknown as TelescopeClient;
  render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client}>
        <AiSection onOpenTrace={onOpenTrace} onOpenEntry={vi.fn()} />
      </TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
  return { client, onOpenTrace };
}

describe('AiSection', () => {
  it('shows spend, runs and unpriced calls', async () => {
    renderAi(summary());
    expect(await screen.findByText('Total cost')).toBeTruthy();
    expect(screen.getByText('$0.016')).toBeTruthy();
    expect(screen.getAllByText('agent:writer').length).toBeGreaterThan(0);
    expect(screen.getByText('whisper-1')).toBeTruthy();
    expect(screen.getAllByText('writer').length).toBeGreaterThan(0);
  });

  it('opens a run with its step breakdown and links to the trace', async () => {
    const { onOpenTrace } = renderAi(summary());
    const rows = await screen.findAllByText('claude-sonnet-4-5');
    fireEvent.click(rows[0] as HTMLElement);
    expect(await screen.findByText('Run run-1')).toBeTruthy();
    expect(screen.getByText(/search_articles/)).toBeTruthy();
    fireEvent.click(screen.getByText('Open trace waterfall'));
    expect(onOpenTrace).toHaveBeenCalledWith('trace-1');
  });

  it('says the agent lib is too old when agent events carry no usage', async () => {
    renderAi(
      summary({
        spend: { ...summary().spend, calls: 0, totalUsd: 0, byFeature: [], buckets: [] },
        unpriced: [],
        coverage: {
          usageEvents: 0,
          runEvents: 1,
          agentEvents: 5,
          legacyAgentLib: true,
          runsWithoutTimings: 1,
        },
      }),
    );
    await waitFor(() => expect(screen.getAllByText(/Not measured\./).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/0\.93\.0/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Total cost')).toBeNull();
  });
});

describe('formatUsd', () => {
  it('keeps sub-cent precision', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.042)).toBe('$0.042');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(null)).toBe('—');
  });
});
