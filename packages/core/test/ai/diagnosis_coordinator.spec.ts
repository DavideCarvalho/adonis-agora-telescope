import { describe, expect, it, vi } from 'vitest';
import type { Diagnosis, ExceptionEntryContent } from '../../src/ai/diagnoser.js';
import {
  type DiagnoserLike,
  DiagnosisCoordinator,
  formatDiagnosisMarkdown,
} from '../../src/ai/diagnosis_coordinator.js';
import { DiagnosisCache } from '../../src/ai/diagnosis_cache.js';
import { SYSTEM_PROMPT } from '../../src/ai/prompt.js';
import {
  type AnthropicMessagesClient,
  TelescopeAiDiagnoser,
} from '../../src/ai/telescope_ai_diagnoser.js';
import type { Entry } from '../../src/entry.js';

function exceptionEntry(
  overrides: Partial<Entry<ExceptionEntryContent>> = {},
): Entry<ExceptionEntryContent> {
  return {
    id: 'e1',
    type: 'exception',
    familyHash: 'TypeError:nope:at foo',
    content: {
      name: 'TypeError',
      message: 'nope',
      stack: 'TypeError: nope\n    at foo (/app/a.ts:10:5)',
      method: 'POST',
      url: '/orders',
      traceId: 'tr-1',
    },
    tags: ['exception:TypeError'],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    traceId: 'tr-1',
    createdAt: new Date(),
    ...overrides,
  };
}

const VALID_JSON = JSON.stringify({
  cause: 'A null user was dereferenced.',
  fix: 'Guard against a missing user before access.',
  confidence: 'high',
});

/** A real diagnoser over a fake Anthropic client that counts calls. */
function fakeDiagnoser(text = VALID_JSON): {
  diagnoser: TelescopeAiDiagnoser;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text }] }));
  const client: AnthropicMessagesClient = { messages: { create } };
  const diagnoser = new TelescopeAiDiagnoser({ client, model: 'claude-sonnet-4-6', maxTokens: 512 });
  return { diagnoser, create };
}

describe('DiagnosisCoordinator', () => {
  it('reports not configured and no-ops when no diagnoser is wired', async () => {
    const coordinator = new DiagnosisCoordinator({ diagnoser: null });
    expect(coordinator.isConfigured()).toBe(false);
    expect(await coordinator.diagnose(exceptionEntry())).toBeNull();
    expect(await coordinator.diagnoseMarkdown(exceptionEntry())).toBeNull();
    expect(await coordinator.diagnoseSummary(exceptionEntry())).toBeNull();
  });

  it('runs a real diagnosis and renders markdown when configured', async () => {
    const { diagnoser, create } = fakeDiagnoser();
    const coordinator = new DiagnosisCoordinator({ diagnoser });

    expect(coordinator.isConfigured()).toBe(true);
    const markdown = await coordinator.diagnoseMarkdown(exceptionEntry());
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].system).toBe(SYSTEM_PROMPT);
    expect(markdown).toContain('Probable cause');
    expect(markdown).toContain('A null user was dereferenced.');
    expect(markdown).toContain('Guard against a missing user');
  });

  it('projects a compact summary for the alerter', async () => {
    const { diagnoser } = fakeDiagnoser();
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const summary = await coordinator.diagnoseSummary(exceptionEntry());
    expect(summary).toEqual({
      cause: 'A null user was dereferenced.',
      fix: 'Guard against a missing user before access.',
      confidence: 'high',
      model: 'claude-sonnet-4-6',
    });
  });

  it('caches/dedups repeated diagnoses of the same family (one model call)', async () => {
    const { diagnoser, create } = fakeDiagnoser();
    const coordinator = new DiagnosisCoordinator({ diagnoser });

    const first = await coordinator.diagnose(exceptionEntry());
    const second = await coordinator.diagnose(exceptionEntry({ id: 'e2' }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(first?.cached).toBe(false);
    expect(second?.cached).toBe(true);
    expect(second?.cause).toBe(first?.cause);
  });

  it('coalesces concurrent in-flight diagnoses of the same family into one call', async () => {
    const { diagnoser, create } = fakeDiagnoser();
    const coordinator = new DiagnosisCoordinator({ diagnoser });

    const [a, b] = await Promise.all([
      coordinator.diagnose(exceptionEntry()),
      coordinator.diagnose(exceptionEntry({ id: 'e2' })),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(a?.cause).toBe(b?.cause);
  });

  it('swallows a throwing diagnoser and never propagates (returns null, logs)', async () => {
    const throwing: DiagnoserLike = {
      diagnose: () => Promise.reject(new Error('model exploded')),
    };
    const logger = vi.fn();
    const coordinator = new DiagnosisCoordinator({ diagnoser: throwing, logger });

    await expect(coordinator.diagnose(exceptionEntry())).resolves.toBeNull();
    expect(await coordinator.diagnoseMarkdown(exceptionEntry())).toBeNull();
    expect(logger).toHaveBeenCalled();
  });

  it('times out a slow diagnoser and returns null without throwing', async () => {
    const hanging: DiagnoserLike = {
      diagnose: () => new Promise<Diagnosis | null>(() => {}), // never resolves
    };
    const coordinator = new DiagnosisCoordinator({ diagnoser: hanging, timeoutMs: 10 });
    await expect(coordinator.diagnose(exceptionEntry())).resolves.toBeNull();
  });

  it('honours an injected cache via the underlying diagnoser', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: VALID_JSON }] }));
    const cache = new DiagnosisCache({ maxEntries: 10 });
    const diagnoser = new TelescopeAiDiagnoser({
      client: { messages: { create } },
      model: 'm',
      maxTokens: 1,
      cache,
    });
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    await coordinator.diagnose(exceptionEntry());
    expect(cache.size).toBe(1);
  });
});

describe('formatDiagnosisMarkdown', () => {
  it('renders confidence, cause and fix', () => {
    const diagnosis: Diagnosis = {
      cause: 'Root cause here.',
      fix: 'Do this.',
      confidence: 'medium',
      model: 'claude-x',
      cached: false,
    };
    const md = formatDiagnosisMarkdown(diagnosis);
    expect(md).toContain('Probable cause');
    expect(md).toContain('medium');
    expect(md).toContain('claude-x');
    expect(md).toContain('Root cause here.');
    expect(md).toContain('Do this.');
  });

  it('marks a cached diagnosis and tolerates empty fields', () => {
    const md = formatDiagnosisMarkdown({
      cause: '',
      fix: '',
      confidence: 'low',
      model: 'm',
      cached: true,
    });
    expect(md).toContain('cached');
    expect(md).toContain('(no cause returned)');
    expect(md).toContain('(no fix returned)');
  });
});
