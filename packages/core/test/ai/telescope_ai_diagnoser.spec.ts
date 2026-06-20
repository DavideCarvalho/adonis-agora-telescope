import { describe, expect, it, vi } from 'vitest';
import type { ExceptionEntryContent } from '../../src/ai/diagnoser.js';
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

/** A fake Anthropic client returning a fixed text payload, counting calls. */
function fakeClient(text: string): {
  client: AnthropicMessagesClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text }] }));
  return { client: { messages: { create } }, create };
}

const VALID_JSON = JSON.stringify({
  cause: 'A null user was dereferenced.',
  fix: 'Guard against a missing user before access.',
  confidence: 'high',
});

describe('TelescopeAiDiagnoser.diagnose', () => {
  it('builds the prompt from the exception entry and parses a Diagnosis', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({
      client,
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    const result = await diagnoser.diagnose(exceptionEntry());

    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(512);
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain('TypeError: nope');
    expect(body.messages[0].content).toContain('POST /orders');
    expect(body.messages[0].content).toContain('at foo');

    expect(result).not.toBeNull();
    expect(result?.cause).toBe('A null user was dereferenced.');
    expect(result?.fix).toBe('Guard against a missing user before access.');
    expect(result?.confidence).toBe('high');
    expect(result?.model).toBe('claude-sonnet-4-6');
    expect(result?.cached).toBe(false);
  });

  it('serves the same family hash from cache without a second API call', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({
      client,
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    const first = await diagnoser.diagnose(exceptionEntry());
    const second = await diagnoser.diagnose(exceptionEntry({ id: 'e2' }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(first?.cached).toBe(false);
    expect(second?.cached).toBe(true);
    expect(second?.cause).toBe(first?.cause);
  });

  it('re-calls the API for a different family hash', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({
      client,
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    await diagnoser.diagnose(exceptionEntry({ familyHash: 'A:1:x' }));
    await diagnoser.diagnose(exceptionEntry({ familyHash: 'B:2:y' }));

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('force bypasses the cache', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1 });
    await diagnoser.diagnose(exceptionEntry());
    await diagnoser.diagnose(exceptionEntry(), { force: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('is a no-op (returns null) when disabled', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({
      client,
      model: 'm',
      maxTokens: 1,
      enabled: false,
    });
    expect(await diagnoser.diagnose(exceptionEntry())).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('handles a malformed (non-JSON) API response gracefully', async () => {
    const { client } = fakeClient('I could not produce JSON, sorry.');
    const logger = vi.fn();
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1, logger });
    expect(await diagnoser.diagnose(exceptionEntry())).toBeNull();
    expect(logger).toHaveBeenCalled();
  });

  it('tolerates JSON wrapped in markdown fences and missing fields', async () => {
    const { client } = fakeClient('```json\n{"cause": "boom"}\n```');
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1 });
    const result = await diagnoser.diagnose(exceptionEntry());
    expect(result?.cause).toBe('boom');
    expect(result?.fix).toBe('');
    expect(result?.confidence).toBe('low'); // missing → defaults low
  });

  it('returns null and logs when the API call throws', async () => {
    const create = vi.fn(async () => {
      throw new Error('429 rate limited');
    });
    const logger = vi.fn();
    const diagnoser = new TelescopeAiDiagnoser({
      client: { messages: { create } },
      model: 'm',
      maxTokens: 1,
      logger,
    });
    expect(await diagnoser.diagnose(exceptionEntry())).toBeNull();
    expect(logger).toHaveBeenCalled();
  });

  it('includes related trace entries in the prompt', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1 });
    const related: Entry[] = [
      {
        id: 'q1',
        type: 'query',
        familyHash: null,
        content: { sql: 'select * from users where id = ?' },
        tags: [],
        sequence: 1,
        durationMs: 3,
        origin: 'http',
        traceId: 'tr-1',
        createdAt: new Date(),
      },
    ];
    await diagnoser.diagnose(exceptionEntry(), { related });
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('[query]');
    expect(prompt).toContain('select * from users');
  });

  it('uses an injected cache implementation', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const cache = new DiagnosisCache({ maxEntries: 10 });
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1, cache });
    await diagnoser.diagnose(exceptionEntry());
    expect(cache.size).toBe(1);
    await diagnoser.diagnose(exceptionEntry());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not cache when the entry has no family hash', async () => {
    const { client, create } = fakeClient(VALID_JSON);
    const diagnoser = new TelescopeAiDiagnoser({ client, model: 'm', maxTokens: 1 });
    await diagnoser.diagnose(exceptionEntry({ familyHash: null }));
    await diagnoser.diagnose(exceptionEntry({ familyHash: null }));
    expect(create).toHaveBeenCalledTimes(2);
  });
});
