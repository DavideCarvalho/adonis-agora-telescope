import type { AlertChannel } from '../alert_channel.js';
import type { AlertPayload } from '../alert_rule.js';
import { plainText } from './chat.js';
import { escapeHtml } from './html.js';
import { type ChannelRouting, clip, linkOf, titleOf } from './incident.js';

/**
 * The slice of an `@adonisjs/mail` message builder the email channel uses.
 * Structural so the lib compiles without `@adonisjs/mail` installed.
 */
export interface MailMessageLike {
  to(address: string): unknown;
  from(address: string): unknown;
  subject(subject: string): unknown;
  text(body: string): unknown;
  html(body: string): unknown;
}

/** The slice of the `@adonisjs/mail` service the email channel uses. */
export interface MailerLike {
  send(compose: (message: MailMessageLike) => void): Promise<unknown>;
  use?(mailer: string): MailerLike;
}

export interface EmailOptions extends ChannelRouting {
  /** Recipients. */
  to: string | string[];
  /** Sender. Default: the mailer's configured `from`. */
  from?: string;
  /** Named mailer from `config/mail.ts`. Default: the default mailer. */
  mailer?: string;
  /** Subject prefix. Default `'[Telescope]'`. */
  subjectPrefix?: string;
  /** Test seam: the mail service. Default: `@adonisjs/mail/services/main`, loaded on first send. */
  mail?: MailerLike | (() => Promise<MailerLike>);
}

/** `@adonisjs/mail` is an optional peer: import it only when an email is sent. */
async function loadMail(): Promise<MailerLike> {
  const specifier = '@adonisjs/mail/services/main';
  try {
    const mod = (await import(specifier)) as { default: MailerLike };
    return mod.default;
  } catch {
    throw new Error('the email channel needs @adonisjs/mail installed and configured');
  }
}

/** The subject, text and HTML bodies for an alert email. */
export function emailContent(
  alert: AlertPayload,
  subjectPrefix = '[Telescope]',
): { subject: string; text: string; html: string } {
  const text = plainText(alert);
  const link = linkOf(alert);
  const html = [
    `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    ...(link !== null ? [`<p><a href="${escapeHtml(link)}">Open in Telescope</a></p>`] : []),
  ].join('\n');
  return { subject: clip(`${subjectPrefix} ${titleOf(alert)}`, 200), text, html };
}

/**
 * Email through `@adonisjs/mail` (an optional peer, loaded on the first send).
 * Uses `mail.send`, so the app's mailer config, transports and fakes all apply.
 */
export function emailChannel(options: EmailOptions): AlertChannel {
  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  let resolved: MailerLike | null = null;
  async function mailService(): Promise<MailerLike> {
    if (resolved !== null) return resolved;
    const source = options.mail;
    const service =
      source === undefined
        ? await loadMail()
        : typeof source === 'function'
          ? await source()
          : source;
    resolved =
      options.mailer !== undefined && typeof service.use === 'function'
        ? service.use(options.mailer)
        : service;
    return resolved;
  }
  return {
    name: options.name ?? 'email',
    ...(options.minSeverity !== undefined ? { minSeverity: options.minSeverity } : {}),
    async send(alert) {
      const mail = await mailService();
      const content = emailContent(alert, options.subjectPrefix);
      await mail.send((message) => {
        for (const address of recipients) message.to(address);
        if (options.from !== undefined) message.from(options.from);
        message.subject(content.subject);
        message.text(content.text);
        message.html(content.html);
      });
    },
  };
}
