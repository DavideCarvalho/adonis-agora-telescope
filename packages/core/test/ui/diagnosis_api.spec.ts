import { beforeEach, describe, expect, it } from 'vitest';
import type { Diagnosis } from '../../src/ai/diagnoser.js';
import { DiagnosisCoordinator } from '../../src/ai/diagnosis_coordinator.js';
import type { DiagnoserLike } from '../../src/ai/diagnosis_coordinator.js';
import type { RecordInput } from '../../src/entry.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { DiagnosisApi } from '../../src/ui/diagnosis_api.js';
import { RecordingResponse, type UiHttpContext, makeRequest } from '../../src/ui/http.js';

function ctx(): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('POST'), response: res }, res };
}

async function seedException(store: InMemoryTelescopeStore, type = 'exception'): Promise<string> {
  const input: RecordInput = {
    type,
    content: { name: 'TypeError', message: 'boom', stack: 'at foo (a.ts:1:1)' },
    familyHash: `${type}:TypeError:boom`,
    origin: 'manual',
  };
  return (await store.record(input)).id;
}

function fakeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    cause: 'A null was passed where an object was expected.',
    fix: 'Add a guard before dereferencing.',
    confidence: 'high',
    model: 'claude-sonnet-4-6',
    cached: false,
    ...overrides,
  };
}

describe('DiagnosisApi.diagnose', () => {
  let store: InMemoryTelescopeStore;
  let service: TelescopeService;

  beforeEach(() => {
    store = new InMemoryTelescopeStore();
    service = new TelescopeService(store);
  });

  it('answers 404 when no coordinator is wired (AI not installed)', async () => {
    const id = await seedException(store);
    const api = new DiagnosisApi(service, null);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/not configured/i);
  });

  it('answers 404 when the coordinator is wired but unconfigured (no API key)', async () => {
    const id = await seedException(store);
    const coordinator = new DiagnosisCoordinator({ diagnoser: null });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for an unknown id', async () => {
    const diagnoser: DiagnoserLike = { diagnose: async () => fakeDiagnosis() };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, 'nope', false);
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 when the entry is not an exception/client_exception', async () => {
    const id = (
      await store.record({
        type: 'diagnostic',
        content: { lib: 'x', event: 'y' },
        origin: 'manual',
      })
    ).id;
    const diagnoser: DiagnoserLike = { diagnose: async () => fakeDiagnosis() };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(404);
  });

  it('accepts client_exception entries too', async () => {
    const id = await seedException(store, 'client_exception');
    const diagnoser: DiagnoserLike = { diagnose: async () => fakeDiagnosis() };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(200);
  });

  it('answers 502 when the coordinator fails/times out (resolves null)', async () => {
    const id = await seedException(store);
    const diagnoser: DiagnoserLike = { diagnose: async () => null };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(502);
  });

  it('returns rendered markdown + cached flag on success', async () => {
    const id = await seedException(store);
    const diagnoser: DiagnoserLike = { diagnose: async () => fakeDiagnosis({ cached: true }) };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c, res } = ctx();
    await api.diagnose(c, id, false);
    expect(res.statusCode).toBe(200);
    const data = (res.body as { data: { markdown: string; cached: boolean } }).data;
    expect(data.cached).toBe(true);
    expect(data.markdown).toContain('Probable cause');
    expect(data.markdown).toContain('Add a guard before dereferencing.');
  });

  it('passes `force` through to the coordinator', async () => {
    const id = await seedException(store);
    let seenForce: boolean | undefined;
    const diagnoser: DiagnoserLike = {
      diagnose: async (_entry, options) => {
        seenForce = options?.force;
        return fakeDiagnosis();
      },
    };
    const coordinator = new DiagnosisCoordinator({ diagnoser });
    const api = new DiagnosisApi(service, coordinator);
    const { ctx: c } = ctx();
    await api.diagnose(c, id, true);
    expect(seenForce).toBe(true);
  });

  it('isConfigured() mirrors the coordinator, and is false with no coordinator', () => {
    expect(new DiagnosisApi(service, null).isConfigured()).toBe(false);
    const configured = new DiagnosisApi(
      service,
      new DiagnosisCoordinator({ diagnoser: { diagnose: async () => fakeDiagnosis() } }),
    );
    expect(configured.isConfigured()).toBe(true);
    const unconfigured = new DiagnosisApi(service, new DiagnosisCoordinator({ diagnoser: null }));
    expect(unconfigured.isConfigured()).toBe(false);
  });
});
