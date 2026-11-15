import { describe, expect, it } from 'vitest';
import {
  discordChannel,
  emailChannel,
  googleChatChannel,
  type MailMessageLike,
  teamsChannel,
  telegramChannel,
} from '../../../src/alerts/index.js';
import { exceptionAlert, fakeSleep, metricAlert, mockFetch } from './helpers.js';

describe('discordChannel', () => {
  it('posts a native embed coloured by severity, with no mentions', async () => {
    const { fetch, calls } = mockFetch();
    await discordChannel({
      url: 'https://discord.com/api/webhooks/1/x',
      username: 'Telescope',
      fetch,
    }).send(exceptionAlert());
    const body = calls[0]?.json as Record<string, any>;
    expect(body.username).toBe('Telescope');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0];
    expect(embed.title).toContain('TypeError: cannot read <x> & y (POST /checkout)');
    expect(embed.url).toBe('https://telescope.example#/entries/view/ex-1');
    expect(embed.color).toBe(0xf04438);
    expect(embed.fields).toContainEqual({ name: 'Occurrences', value: '3', inline: true });
    expect(embed.description).toContain('at a');
  });

  it('turns green on resolve', async () => {
    const { fetch, calls } = mockFetch();
    await discordChannel({ url: 'https://d.example', fetch }).send(metricAlert('resolved'));
    expect((calls[0]!.json as any).embeds[0].color).toBe(0x12b76a);
  });
});

describe('teamsChannel', () => {
  it('posts an Adaptive Card attachment with facts and a link', async () => {
    const { fetch, calls } = mockFetch();
    await teamsChannel({ url: 'https://prod.workflows.example/x', fetch }).send(metricAlert());
    const body = calls[0]?.json as Record<string, any>;
    expect(body.type).toBe('message');
    const card = body.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.type).toBe('AdaptiveCard');
    expect(card.content.body[1].facts).toContainEqual({ title: 'Value', value: '812.5' });
    expect(card.content.actions[0]).toMatchObject({ type: 'Action.OpenUrl' });
  });
});

describe('telegramChannel', () => {
  it('sends HTML-escaped text to the chat', async () => {
    const { fetch, calls } = mockFetch();
    await telegramChannel({ botToken: '123:ABC', chatId: -100, messageThreadId: 7, fetch }).send(
      exceptionAlert(),
    );
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    const body = calls[0]?.json as Record<string, any>;
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(7);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('cannot read &lt;x&gt; &amp; y');
  });

  it('never leaks the bot token in a failure', async () => {
    const { fetch } = mockFetch([new Error('getaddrinfo api.telegram.org/bot123:ABC')]);
    const { sleep } = fakeSleep();
    const error = await telegramChannel({ botToken: '123:ABC', chatId: 1, fetch, sleep })
      .send(metricAlert())
      .catch((e: Error) => e);
    expect((error as Error).message).not.toContain('123:ABC');
  });
});

describe('googleChatChannel', () => {
  it('threads by app + rule and sends a card', async () => {
    const { fetch, calls } = mockFetch();
    await googleChatChannel({
      url: 'https://chat.googleapis.com/v1/spaces/S/messages?key=K',
      fetch,
    }).send(metricAlert());
    expect(calls[0]?.url).toBe(
      'https://chat.googleapis.com/v1/spaces/S/messages?key=K&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    );
    const body = calls[0]?.json as Record<string, any>;
    expect(body.thread).toEqual({ threadKey: 'telescope-web-1-metric-threshold' });
    expect(body.cardsV2[0].card.header.title).toContain('request-p99-ms');
  });
});

describe('emailChannel', () => {
  it('composes through the injected mail service', async () => {
    const sent: Record<string, unknown>[] = [];
    const used: string[] = [];
    const mail = {
      use(name: string) {
        used.push(name);
        return mail;
      },
      async send(compose: (message: MailMessageLike) => void) {
        const message: Record<string, unknown> = { to: [] as string[] };
        compose({
          to: (a) => (message.to as string[]).push(a),
          from: (a) => (message.from = a),
          subject: (s) => (message.subject = s),
          text: (t) => (message.text = t),
          html: (h) => (message.html = h),
        });
        sent.push(message);
      },
    };
    await emailChannel({
      to: ['a@example.com', 'b@example.com'],
      from: 'alerts@example.com',
      mailer: 'smtp',
      mail,
    }).send(exceptionAlert());
    expect(used).toEqual(['smtp']);
    expect(sent[0]?.to).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0]?.subject).toMatch(/^\[Telescope\] \[error\] web-1: TypeError/);
    expect(sent[0]?.text).toContain('Occurrences in window: 3');
    expect(sent[0]?.html).toContain('cannot read &lt;x&gt; &amp; y');
  });

  it('rejects clearly when @adonisjs/mail is not installed', async () => {
    await expect(emailChannel({ to: 'a@example.com' }).send(metricAlert())).rejects.toThrow(
      '@adonisjs/mail',
    );
  });
});
