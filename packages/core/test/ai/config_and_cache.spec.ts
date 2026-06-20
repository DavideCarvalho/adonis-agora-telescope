import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/ai/define_config.js';
import { type Diagnosis, normalizeConfidence, parseDiagnosis } from '../../src/ai/diagnoser.js';
import { DiagnosisCache } from '../../src/ai/diagnosis_cache.js';

const diag = (cause: string): Diagnosis => ({
  cause,
  fix: 'f',
  confidence: 'high',
  model: 'm',
  cached: false,
});

describe('resolveConfig', () => {
  it('applies defaults when a key is present', () => {
    const c = resolveConfig({ apiKey: 'sk-test' });
    expect(c.enabled).toBe(true);
    expect(c.apiKey).toBe('sk-test');
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.maxTokens).toBe(1024);
  });

  it('is disabled when no key resolves', () => {
    expect(resolveConfig().enabled).toBe(false);
    expect(resolveConfig({ apiKey: '   ' }).enabled).toBe(false);
    expect(resolveConfig().apiKey).toBeNull();
  });

  it('stays disabled when explicitly disabled even with a key', () => {
    expect(resolveConfig({ apiKey: 'sk', enabled: false }).enabled).toBe(false);
  });

  it('respects model and maxTokens overrides', () => {
    const c = resolveConfig({ apiKey: 'sk', model: 'claude-opus-4-8', maxTokens: 256 });
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.maxTokens).toBe(256);
  });
});

describe('normalizeConfidence', () => {
  it('accepts the three valid levels case-insensitively', () => {
    expect(normalizeConfidence('High')).toBe('high');
    expect(normalizeConfidence('  MEDIUM ')).toBe('medium');
    expect(normalizeConfidence('low')).toBe('low');
  });
  it('defaults anything else to low', () => {
    expect(normalizeConfidence('certain')).toBe('low');
    expect(normalizeConfidence(undefined)).toBe('low');
  });
});

describe('parseDiagnosis', () => {
  it('parses a bare JSON object', () => {
    const p = parseDiagnosis('{"cause":"c","fix":"f","confidence":"medium"}');
    expect(p).toEqual({ cause: 'c', fix: 'f', confidence: 'medium' });
  });
  it('extracts JSON wrapped in prose / fences', () => {
    const p = parseDiagnosis(
      'Here you go:\n```json\n{"cause":"c","fix":"f","confidence":"low"}\n```',
    );
    expect(p.cause).toBe('c');
  });
  it('tolerates braces inside string values', () => {
    const p = parseDiagnosis('{"cause":"use {x} guard","fix":"f","confidence":"high"}');
    expect(p.cause).toBe('use {x} guard');
  });
  it('throws when no JSON object is present', () => {
    expect(() => parseDiagnosis('no json here')).toThrow();
  });
  it('throws on malformed JSON', () => {
    expect(() => parseDiagnosis('{not valid}')).toThrow();
  });
});

describe('DiagnosisCache', () => {
  it('returns null on a miss and the value on a hit', () => {
    const c = new DiagnosisCache();
    expect(c.get('x')).toBeNull();
    c.set('x', diag('hit'));
    expect(c.get('x')?.cause).toBe('hit');
  });

  it('expires entries past the TTL', () => {
    let now = 1000;
    const c = new DiagnosisCache({ ttlMs: 100, now: () => now });
    c.set('x', diag('old'));
    now = 1099;
    expect(c.get('x')?.cause).toBe('old');
    now = 1101;
    expect(c.get('x')).toBeNull();
  });

  it('evicts the least-recently-used entry past the cap', () => {
    const c = new DiagnosisCache({ maxEntries: 2 });
    c.set('a', diag('a'));
    c.set('b', diag('b'));
    c.get('a'); // touch a → b is now LRU
    c.set('c', diag('c')); // evicts b
    expect(c.get('a')?.cause).toBe('a');
    expect(c.get('b')).toBeNull();
    expect(c.get('c')?.cause).toBe('c');
  });
});
