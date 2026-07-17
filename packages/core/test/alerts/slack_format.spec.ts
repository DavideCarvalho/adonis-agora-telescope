import { describe, expect, it } from 'vitest';
import { chunkContextFields } from '../../src/alerts/slack_format.js';

describe('chunkContextFields — Slack section field cap', () => {
  it('keeps every chunk at or under 10 fields and drops none', () => {
    // A fully-enriched exception alert produces 11 context fields (instance +
    // observed + error + route + UA + referer + duration + user + client IP +
    // location + occurrences). Slack caps a `section` block's `fields` at 10 and
    // rejects the WHOLE message with 400 invalid_blocks on the 11th, so the
    // fields MUST spread across more than one section instead of overflowing one.
    const eleven = Array.from({ length: 11 }, (_, i) => `field-${i}`);
    const chunks = chunkContextFields(eleven);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    // No field dropped in the process — all 11 survive across the chunks.
    expect(chunks.flat()).toEqual(eleven);
  });

  it('leaves a within-cap list in a single chunk', () => {
    const six = Array.from({ length: 6 }, (_, i) => i);
    const chunks = chunkContextFields(six);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(six);
  });

  it('returns no chunks for an empty list', () => {
    expect(chunkContextFields([])).toEqual([]);
  });
});
