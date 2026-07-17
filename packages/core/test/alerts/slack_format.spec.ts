import { describe, expect, it } from 'vitest';
import type { AlertPayload, ExceptionAlertContext } from '../../src/alerts/alert_rule.js';
import { chunkContextFields, formatSlackMessage } from '../../src/alerts/slack_format.js';

type SectionBlock = { type: 'section'; text?: { text: string }; fields?: { text: string }[] };

function exceptionContext(over: Partial<ExceptionAlertContext> = {}): ExceptionAlertContext {
  return {
    familyHash: 'fam-A',
    class: 'TypeError',
    message: 'cannot read x',
    stack: 'TypeError: cannot read x\n  at a',
    route: '/checkout',
    method: 'POST',
    statusCode: 500,
    userAgent: null,
    referer: null,
    componentStack: null,
    extra: null,
    client: false,
    clientIp: null,
    geo: null,
    durationMs: null,
    user: '42',
    occurrences: 3,
    entryId: 'ex-1',
    ...over,
  };
}

function exceptionPayload(exception: ExceptionAlertContext): AlertPayload {
  return {
    rule: { type: 'every-exception' },
    value: exception.occurrences,
    threshold: 1,
    firedAt: '2026-07-17T00:00:00.000Z',
    instanceId: 'host-1',
    exception,
  };
}

/** Every rendered field's text across all section-with-fields blocks. */
function fieldTexts(message: { blocks: SectionBlock[] }): string[] {
  return message.blocks
    .filter((b): b is SectionBlock => b.type === 'section' && Array.isArray(b.fields))
    .flatMap((b) => (b.fields ?? []).map((f) => f.text));
}

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

describe('formatSlackMessage — enriched exception (d11295d)', () => {
  it('renders Client IP, Location (geo w/ flag), Referer and User agent fields', () => {
    const message = formatSlackMessage(
      exceptionPayload(
        exceptionContext({
          userAgent: 'Mozilla/5.0',
          referer: 'https://app.example/from',
          clientIp: '198.51.100.9',
          geo: { city: 'São Paulo', region: 'SP', country: 'Brazil', countryCode: 'BR' },
        }),
      ),
    ) as { blocks: SectionBlock[] };

    const texts = fieldTexts(message).join('\n');
    expect(texts).toContain('*Client IP:*\n198.51.100.9');
    expect(texts).toContain('*User agent:*\nMozilla/5.0');
    expect(texts).toContain('*Referer:*\nhttps://app.example/from');
    // Location renders the BR flag + a de-duplicated city/region/country.
    expect(texts).toMatch(/\*Location:\*\n🇧🇷 São Paulo, SP, Brazil/);
  });

  it('spreads a fully-enriched exception across sections, none over 10 fields, none dropped', () => {
    // instance + observed + error + route + UA + referer + duration + user +
    // client IP + location + occurrences = 11 fields → must NOT overflow one section.
    const message = formatSlackMessage(
      exceptionPayload(
        exceptionContext({
          userAgent: 'Mozilla/5.0',
          referer: 'https://app.example/from',
          durationMs: 128,
          clientIp: '198.51.100.9',
          geo: { city: 'São Paulo', countryCode: 'BR' },
        }),
      ),
    ) as { blocks: SectionBlock[] };

    const fieldSections = message.blocks.filter(
      (b): b is SectionBlock => b.type === 'section' && Array.isArray(b.fields),
    );
    expect(fieldSections.length).toBeGreaterThan(1);
    for (const s of fieldSections) expect((s.fields ?? []).length).toBeLessThanOrEqual(10);
    expect(fieldTexts(message).length).toBe(11);
  });

  it('renders a component stack block and a JSON extra block for a client_exception', () => {
    const message = formatSlackMessage(
      exceptionPayload(
        exceptionContext({
          client: true,
          componentStack: 'at App\n  at Router',
          extra: { buildId: 'abc123' },
        }),
      ),
    ) as { blocks: SectionBlock[] };

    const bodies = message.blocks
      .filter((b): b is SectionBlock => b.type === 'section' && typeof b.text?.text === 'string')
      .map((b) => b.text?.text ?? '');
    expect(bodies.some((t) => t.includes('*Component stack:*') && t.includes('at Router'))).toBe(
      true,
    );
    expect(bodies.some((t) => t.includes('*Extra:*') && t.includes('buildId'))).toBe(true);
  });

  it('labels an every-exception alert "Exception" with the rotating-light severity', () => {
    const message = formatSlackMessage(exceptionPayload(exceptionContext()));
    const header = message.blocks[0] as { type: string; text: { text: string } };
    expect(header.type).toBe('header');
    expect(header.text.text).toContain('Exception');
    expect(header.text.text).toContain(':rotating_light:');
  });
});
