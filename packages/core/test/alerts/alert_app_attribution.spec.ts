import { describe, expect, it } from 'vitest';
import { consoleChannel } from '../../src/alerts/alert_channel.js';
import type { AlertPayload, ExceptionAlertContext } from '../../src/alerts/alert_rule.js';
import { appOf } from '../../src/alerts/integrations/incident.js';
import { formatSlackMessage } from '../../src/alerts/slack_format.js';

/**
 * On a control plane the alerter runs in the central server (`instanceId` = that server), but an
 * exception belongs to the tenant app that recorded it (its `app:` tag). The alert must name the
 * tenant, not the server that evaluated the rule.
 */
function exception(over: Partial<ExceptionAlertContext> = {}): ExceptionAlertContext {
  return {
    familyHash: 'fam-A',
    class: 'Error',
    message: 'Chunk perdido em deploy',
    stack: null,
    route: 'https://www.example.test/acervo',
    method: null,
    statusCode: null,
    userAgent: null,
    referer: null,
    componentStack: null,
    extra: null,
    client: true,
    clientIp: null,
    geo: null,
    durationMs: null,
    user: null,
    occurrences: 2,
    isNew: false,
    entryId: 'ex-1',
    ...over,
  };
}

function payload(ctx: ExceptionAlertContext): AlertPayload {
  return {
    rule: { type: 'every-exception' },
    value: ctx.occurrences,
    threshold: 1,
    firedAt: '2026-11-17T12:31:00.000Z',
    instanceId: 'agora-hub',
    exception: ctx,
  };
}

describe('alerts name the app that recorded the exception', () => {
  it('appOf prefers the exception app over the reporting instance', () => {
    expect(appOf(payload(exception({ app: 'entre-textos' })))).toBe('entre-textos');
  });

  it('appOf falls back to the reporting instance for an untagged exception', () => {
    expect(appOf(payload(exception({ app: null })))).toBe('agora-hub');
    expect(appOf(payload(exception()))).toBe('agora-hub');
  });

  it('the console summary names the tenant', async () => {
    const lines: string[] = [];
    await consoleChannel((line) => lines.push(line)).send(
      payload(exception({ app: 'entre-textos' })),
    );
    expect(lines[0]).toContain('every-exception on entre-textos');
  });

  it('the Slack card carries an App field for the exception', () => {
    const message = formatSlackMessage(payload(exception({ app: 'entre-textos' }))) as unknown as {
      blocks: { type: string; fields?: { text: string }[] }[];
    };
    const fields = message.blocks.flatMap((b) => (b.fields ?? []).map((f) => f.text));
    expect(fields.some((text) => text.includes('App') && text.includes('entre-textos'))).toBe(true);
  });
});
