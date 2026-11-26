import { describe, expect, it } from 'vitest';
import { viewerAllows } from './viewer-capabilities.js';

describe('viewerAllows', () => {
  it('matches like the server: exact, wildcards, and write covering the actions', () => {
    expect(viewerAllows(['telescope:console:read'], 'telescope:console:read')).toBe(true);
    expect(viewerAllows(['telescope:console:read'], 'telescope:console:replay')).toBe(false);
    expect(viewerAllows(['telescope:console:*'], 'telescope:console:queues')).toBe(true);
    expect(viewerAllows(['*'], 'telescope:console:replay')).toBe(true);
    expect(viewerAllows(['telescope:console:write'], 'telescope:console:replay')).toBe(true);
    // Write implies read (§10.16b).
    expect(viewerAllows(['telescope:console:write'], 'telescope:console:read')).toBe(true);
    expect(viewerAllows([], 'telescope:console:read')).toBe(false);
    // Look-alikes: a key-name wildcard matcher would let these through; the server does not.
    expect(viewerAllows(['telescope:console:q*'], 'telescope:console:queues')).toBe(false);
    expect(viewerAllows(['telescope:console'], 'telescope:console:read')).toBe(false);
    expect(viewerAllows(['telescope:*:read'], 'telescope:console:read')).toBe(false);
    expect(viewerAllows(['*:console:*'], 'telescope:console:read')).toBe(false);
    expect(viewerAllows(['flags:console:*'], 'telescope:console:read')).toBe(false);
    expect(viewerAllows(['telescope:console:read'], 'telescope:console:write')).toBe(false);
    expect(viewerAllows(['telescope:console:write'], 'telescope:console:write')).toBe(true);
  });
});
