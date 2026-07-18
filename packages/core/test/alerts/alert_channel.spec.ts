import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AlertPayload,
  consoleChannel,
  customChannel,
  slackChannel,
  webhookChannel,
} from '../../src/alerts/index.js';

function ratePayload(): AlertPayload {
  return {
    rule: { type: 'exception-rate', window: '5m', threshold: 3 },
    value: 5,
    threshold: 3,
    firedAt: '2026-06-05T00:00:00.000Z',
    instanceId: 'host-1',
  };
}

function exceptionPayload(): AlertPayload {
  return {
    rule: { type: 'new-exception', window: '1h' },
    value: 1,
    threshold: 1,
    firedAt: '2026-06-05T00:00:00.000Z',
    instanceId: 'host-1',
    dashboardUrl: 'https://telescope.example/',
    exception: {
      familyHash: 'fam-A',
      class: 'TypeError',
      message: 'cannot read x',
      stack: 'TypeError: cannot read x\n  at a\n  at b',
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
      occurrences: 1,
      isNew: true,
      entryId: 'ex-1',
    },
  };
}

describe('webhookChannel', () => {
  it('POSTs the raw AlertPayload as JSON', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const channel = webhookChannel('https://hook.example/x', fetchMock);
    const payload = ratePayload();
    await channel.send(payload);
    expect(channel.name).toBe('webhook');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://hook.example/x');
    expect(init?.method).toBe('POST');
    expect(init?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init?.body ?? '')).toEqual(payload);
  });

  it('rejects on a non-2xx fetch response (warn-loggable failure)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    const channel = webhookChannel('https://hook.example/x', fetchMock);
    await expect(channel.send(ratePayload())).rejects.toThrow(/500/);
  });
});

describe('consoleChannel', () => {
  it('writes a one-line summary to the sink and never rejects', async () => {
    const sink = vi.fn();
    const channel = consoleChannel(sink);
    await channel.send(exceptionPayload());
    expect(channel.name).toBe('console');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toContain('TypeError: cannot read x');
  });
});

describe('customChannel', () => {
  it('calls the supplied fn with the payload', async () => {
    const fn = vi.fn(() => Promise.resolve());
    const channel = customChannel(fn, 'pager');
    const payload = ratePayload();
    await channel.send(payload);
    expect(channel.name).toBe('pager');
    expect(fn).toHaveBeenCalledWith(payload);
  });

  it('defaults the name to "custom"', () => {
    expect(customChannel(async () => {}).name).toBe('custom');
  });
});

describe('slackChannel', () => {
  it('POSTs Block Kit blocks with a header, fields, stack, and dashboard link', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const channel = slackChannel('https://hooks.slack.com/x', undefined, fetchMock);
    await channel.send(exceptionPayload());
    expect(channel.name).toBe('slack');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.slack.com/x');
    const body = JSON.parse(init?.body ?? '');

    const header = body.blocks[0];
    expect(header.type).toBe('header');
    expect(header.text.text).toContain('New exception family');

    const fieldText = body.blocks
      .filter((b: { type: string }) => b.type === 'section')
      .flatMap((b: { fields?: { text: string }[] }) => b.fields ?? [])
      .map((f: { text: string }) => f.text)
      .join('\n');
    expect(fieldText).toContain('/checkout');
    expect(fieldText).toContain('42');
    expect(fieldText).toContain('Occurrences');

    const hasStack = body.blocks.some(
      (b: { text?: { text?: string } }) =>
        typeof b.text?.text === 'string' && b.text.text.includes('```'),
    );
    expect(hasStack).toBe(true);

    const actions = body.blocks.find((b: { type: string }) => b.type === 'actions');
    expect(actions.elements[0].url).toBe('https://telescope.example#/entries/view/ex-1');
  });

  it('omits the dashboard link button when no dashboardUrl is configured', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const channel = slackChannel('https://hooks.slack.com/x', undefined, fetchMock);
    const payload = exceptionPayload();
    payload.dashboardUrl = undefined;
    await channel.send(payload);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false);
  });

  it('renders a rate-rule payload (no exception context) without crashing', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const channel = slackChannel('https://hooks.slack.com/x', undefined, fetchMock);
    await channel.send(ratePayload());
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body.blocks[0].text.text).toContain('Exception rate');
    expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false);
  });

  it('applies username/iconEmoji overrides', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const channel = slackChannel(
      'https://hooks.slack.com/x',
      { username: 'Telescope', iconEmoji: ':rotating_light:' },
      fetchMock,
    );
    await channel.send(ratePayload());
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body.username).toBe('Telescope');
    expect(body.icon_emoji).toBe(':rotating_light:');
  });

  afterEach(() => vi.restoreAllMocks());
});
