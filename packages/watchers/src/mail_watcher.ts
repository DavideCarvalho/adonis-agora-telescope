import { EntryType, type RecordInput, currentTraceId } from '@agora/telescope';
import type { EmitterLike, Watcher } from './emitter.js';
import { safeRecord } from './record.js';

/** The `@adonisjs/mail` event name this watcher subscribes to. */
export const MAIL_SENT_EVENT = 'mail:sent';

/**
 * A single addressable recipient as `@adonisjs/mail` shapes them — either a bare
 * address string or `{ address, name? }`. Mirrored structurally.
 */
type MailAddress = string | { address?: string; name?: string };

/**
 * The structural slice of the `mail:sent` payload this watcher reads. The exact
 * runtime shape is owned by `@adonisjs/mail` (not installed in this repo, so it
 * could not be verified against its types — see this package's README). The
 * watcher therefore reads every field defensively and degrades to `null`/`[]` for
 * anything missing, rather than assuming a precise shape.
 *
 * `@adonisjs/mail` carries the composed message under `message` — typically a
 * `Message` instance exposing `toJSON()`/`toObject()` whose `.message` holds the
 * envelope (`to`/`from`/`subject`/…). Both the instance form and a plain-object
 * form are handled.
 */
export interface MailSentEventLike {
  mailerName?: string;
  message?: unknown;
}

/** The recorded body of a `mail` entry. */
export interface MailEntryContent {
  /** The mailer that sent the message (e.g. `'smtp'`), or `null`. */
  mailer: string | null;
  /** The sender address, or `null`. */
  from: string | null;
  /** The recipient addresses (`to`), flattened to strings. */
  to: string[];
  /** The subject line, or `null`. */
  subject: string | null;
  /** The active trace id at send time, or `null`. */
  traceId: string | null;
}

/** Normalize a mail address (string | `{address}`) to a plain address string. */
function addressToString(value: MailAddress): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.address === 'string') return value.address;
  return null;
}

/** Normalize a `to` field (one address, or many) to a flat string[]. */
function normalizeRecipients(to: unknown): string[] {
  const list = Array.isArray(to) ? to : to === undefined || to === null ? [] : [to];
  const out: string[] = [];
  for (const item of list) {
    const address = addressToString(item as MailAddress);
    if (address) out.push(address);
  }
  return out;
}

/** Pull the message envelope object out of the (instance-or-plain) `message`. */
function readEnvelope(message: unknown): Record<string, unknown> | null {
  if (message === null || typeof message !== 'object') return null;
  const candidate = message as Record<string, unknown>;
  // `Message` instances expose `toJSON()` returning `{ message, views }`.
  if (typeof candidate.toJSON === 'function') {
    try {
      const json = (candidate.toJSON as () => unknown)();
      if (json && typeof json === 'object') {
        const inner = (json as Record<string, unknown>).message;
        if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
      }
    } catch {
      // fall through to the structural reads below
    }
  }
  // Plain-object form: either the envelope itself, or `{ message: envelope }`.
  if (candidate.message && typeof candidate.message === 'object') {
    return candidate.message as Record<string, unknown>;
  }
  return candidate;
}

/**
 * Records every email AdonisJS sends as a `mail` telescope entry. Subscribes to
 * `@adonisjs/mail`'s `mail:sent` event and captures the mailer, sender, recipients
 * and subject, correlated to the active request via the trace id.
 *
 * Recording is fire-and-forget and fully guarded — a telescope failure can never
 * break a send.
 */
export class MailWatcher implements Watcher {
  readonly type = EntryType.Mail;
  private unsubscribe: (() => void) | null = null;

  start(emitter: EmitterLike): void {
    if (this.unsubscribe) return;
    this.unsubscribe = emitter.on(MAIL_SENT_EVENT, (data) => this.handle(data));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handle(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    safeRecord(buildMailEntry(data as MailSentEventLike), 'MailWatcher');
  }
}

/** Map a `mail:sent` payload to a telescope {@link RecordInput}. */
export function buildMailEntry(event: MailSentEventLike): RecordInput<MailEntryContent> {
  const mailer = typeof event.mailerName === 'string' ? event.mailerName : null;
  const envelope = readEnvelope(event.message);

  const from = envelope ? (addressToString(envelope.from as MailAddress) ?? null) : null;
  const to = envelope ? normalizeRecipients(envelope.to) : [];
  const subject =
    envelope && typeof envelope.subject === 'string' ? (envelope.subject as string) : null;

  const traceId = currentTraceId();
  const content: MailEntryContent = { mailer, from, to, subject, traceId };
  return {
    type: EntryType.Mail,
    familyHash: mailer,
    content,
    traceId,
    tags: [...(mailer ? [`mailer:${mailer}`] : [])],
  };
}
