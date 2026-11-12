import { describe, expect, it } from 'vitest';
import { callerOf } from '../../src/ui/caller.js';
import { makeRequest, RecordingResponse } from '../../src/ui/http.js';

describe('callerOf', () => {
  it('prefers the signed-in user', () => {
    const ctx = {
      request: makeRequest('POST', {}, { authorization: 'Bearer abc' }),
      response: new RecordingResponse(),
      auth: { user: { id: 42 } },
    };
    expect(callerOf(ctx)).toEqual({ id: 'user:42' });
  });

  it('hashes a bearer token, never echoing it', () => {
    const ctx = {
      request: makeRequest('POST', {}, { authorization: 'Bearer secret-token' }),
      response: new RecordingResponse(),
    };
    const { id } = callerOf(ctx);
    expect(id).toMatch(/^token:[0-9a-f]{12}$/);
    expect(id).not.toContain('secret');
  });

  it('falls back to anonymous', () => {
    expect(callerOf({ request: makeRequest('POST'), response: new RecordingResponse() })).toEqual({
      id: 'anonymous',
    });
  });
});
