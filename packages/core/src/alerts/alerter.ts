import { type Entry, EntryType } from '../entry.js';
import type { AlertChannel } from './alert_channel.js';
import type {
  AlertDiagnosis,
  AlertGeoLocation,
  AlertPayload,
  AlertRule,
  ExceptionAlertContext,
  ResolvedAlerts,
} from './alert_rule.js';
import { NewExceptionTracker } from './new_exception_tracker.js';
import { durationToMs } from './parse_duration.js';

/** Stack frames carried in a `new-exception` alert (the Slack channel re-clips). */
const ALERT_STACK_FRAME_LIMIT = 12;

/** Window used only to count occurrences on an `every-exception` alert when the
 *  rule omits its own `window`. Firing is per-flush, so this is display-only. */
const DEFAULT_EVERY_WINDOW = '1h';

export interface AlerterDeps {
  alerts: ResolvedAlerts;
  /** Wall-clock seam (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Cap on tracked error families for the `new-exception` rule (test seam). */
  maxFamilies?: number;
  /** Failure log sink. Defaults to `console.warn`. */
  logger?: (message: string) => void;
  /**
   * Optional AI probable-cause hook. When present, a `new-exception` alert awaits
   * it (fail-safe / time-bounded by the caller — usually the diagnosis
   * coordinator) and attaches the result to the payload's `diagnosis` field. Omit
   * (the default) and alerts behave exactly as before, with no AI section. Must
   * never throw; the alerter additionally guards it.
   */
  diagnose?: (entry: Entry) => Promise<AlertDiagnosis | null>;
}

/**
 * Wires a source of exception {@link Entry} objects → rule evaluation → channels.
 *
 * Two evaluation paths, both driven by {@link evaluate} (called once per poll with
 * the exception entries observed since the last poll):
 *  1. The `new-exception` rule fires the FIRST time a family hash is seen within
 *     its window (and again after the window elapses / a {@link resolveFamily}),
 *     deduped by {@link NewExceptionTracker} and rate-limited by the per-family
 *     cooldown.
 *  2. The `exception-rate` rule fires when the running count of exception entries
 *     in its trailing window crosses the threshold, rate-limited by a per-rule
 *     cooldown.
 *
 * Every fired alert fans out to ALL configured channels concurrently; one channel
 * failing never blocks the others. NEVER throws into the caller: a channel failure
 * is warn-logged (rate-limited per channel) and otherwise swallowed.
 */
export class Alerter {
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly tracker: NewExceptionTracker;
  /** Per-rule-index last-fired wall time for the rate-rule cooldown. */
  private readonly lastFiredAt = new Map<number, number>();
  /** Per-family last-fired wall time for the `new-exception` cooldown. */
  private readonly lastFiredFamily = new Map<string, number>();
  /** Channels we've already warned about (rate-limit failure logs by name). */
  private readonly warnedChannels = new Set<string>();
  /** Sliding-window timestamps of recent exception entries (rate rule). */
  private readonly recentExceptions: number[] = [];

  constructor(private readonly deps: AlerterDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? ((message) => console.warn(message));
    this.tracker = new NewExceptionTracker(deps.maxFamilies);
  }

  /**
   * Evaluate every rule over a freshly-observed batch of exception entries. Safe
   * to call with an empty batch (rate rules still re-check their window against
   * already-recorded timestamps). Never throws into the caller.
   */
  async evaluate(exceptionEntries: Entry[]): Promise<void> {
    if (!this.deps.alerts.enabled) return;
    const nowMs = this.now();
    try {
      // Record each exception at its OWN event time (not poll time), so the
      // rate window reflects when errors actually happened. The poller feeds
      // entries oldest-first, so timestamps stay ascending for the cutoff shift.
      for (const entry of exceptionEntries) {
        this.recentExceptions.push(entry.createdAt.getTime());
      }
      await this.evaluateNewException(exceptionEntries, nowMs);
      await this.evaluateEveryException(exceptionEntries, nowMs);
      await this.evaluateExceptionRate(nowMs);
    } catch (error: unknown) {
      // A bug in evaluation must never break the caller's poll loop.
      this.logger(`Telescope alert evaluation failed: ${asMessage(error)}`);
    }
  }

  /**
   * Explicitly forget a family so its next occurrence pages again immediately —
   * the "resolved → re-occurred" path. Also clears its cooldown.
   */
  resolveFamily(familyHash: string): void {
    this.tracker.resolve(familyHash);
    // Clear BOTH flush rules' independent per-family cooldown clocks.
    this.lastFiredFamily.delete(this.cooldownKey('new-exception', familyHash));
    this.lastFiredFamily.delete(this.cooldownKey('every-exception', familyHash));
  }

  /** Number of error families currently tracked (test/observability seam). */
  get trackedFamilies(): number {
    return this.tracker.size;
  }

  private async evaluateNewException(entries: Entry[], nowMs: number): Promise<void> {
    const result = this.findRule('new-exception');
    if (result === null) return;
    const windowMs = durationToMs(result.rule.window);
    // Count occurrences per family once (O(n)) instead of re-scanning the batch
    // per entry (O(n²)). This is the count within this poll batch.
    const occurrencesByFamily = new Map<string, number>();
    for (const entry of entries) {
      if (entry.familyHash === null) continue;
      occurrencesByFamily.set(
        entry.familyHash,
        (occurrencesByFamily.get(entry.familyHash) ?? 0) + 1,
      );
    }
    for (const entry of entries) {
      if (entry.familyHash === null) continue;
      const isNew = this.tracker.observe(entry.familyHash, nowMs, windowMs);
      if (!isNew) continue;
      if (this.familyInCooldown('new-exception', entry.familyHash, nowMs)) continue;
      this.lastFiredFamily.set(this.cooldownKey('new-exception', entry.familyHash), nowMs);
      const occurrences = occurrencesByFamily.get(entry.familyHash) ?? 1;
      const payload = await this.buildExceptionPayload(result.rule, entry, occurrences, nowMs);
      // Optionally enrich with an AI probable-cause section when a diagnose hook is
      // wired. The hook is expected to be fail-safe/time-bounded (the coordinator
      // is); we guard it anyway so a diagnosis failure never blocks the alert.
      const diagnosis = await this.safeDiagnose(entry);
      if (diagnosis !== null) payload.diagnosis = diagnosis;
      await this.dispatch(payload);
    }
  }

  /**
   * The `every-exception` rule: fire for EVERY exception (server + client), not
   * just brand-new families, rate-limited PER FAMILY by the shared cooldown on an
   * independent clock from `new-exception`. The optional `window` only counts
   * occurrences shown on the alert; it does NOT gate firing.
   */
  private async evaluateEveryException(entries: Entry[], nowMs: number): Promise<void> {
    const result = this.findRule('every-exception');
    if (result === null) return;
    const occurrencesByFamily = new Map<string, number>();
    for (const entry of entries) {
      if (entry.familyHash === null) continue;
      occurrencesByFamily.set(
        entry.familyHash,
        (occurrencesByFamily.get(entry.familyHash) ?? 0) + 1,
      );
    }
    for (const entry of entries) {
      if (entry.familyHash === null) continue;
      if (this.familyInCooldown('every-exception', entry.familyHash, nowMs)) continue;
      this.lastFiredFamily.set(this.cooldownKey('every-exception', entry.familyHash), nowMs);
      const occurrences = occurrencesByFamily.get(entry.familyHash) ?? 1;
      const payload = await this.buildExceptionPayload(result.rule, entry, occurrences, nowMs);
      const diagnosis = await this.safeDiagnose(entry);
      if (diagnosis !== null) payload.diagnosis = diagnosis;
      await this.dispatch(payload);
    }
  }

  /** Run the optional diagnose hook, swallowing any failure to `null`. */
  private async safeDiagnose(entry: Entry): Promise<AlertDiagnosis | null> {
    const diagnose = this.deps.diagnose;
    if (diagnose === undefined) return null;
    try {
      return await diagnose(entry);
    } catch (error: unknown) {
      this.logger(`Telescope alert diagnosis failed: ${asMessage(error)}`);
      return null;
    }
  }

  private async evaluateExceptionRate(nowMs: number): Promise<void> {
    const result = this.findRule('exception-rate');
    if (result === null) return;
    const { rule, index } = result;
    const windowMs = durationToMs(rule.window);
    // Drop timestamps that have aged out of the window.
    const cutoff = nowMs - windowMs;
    while (this.recentExceptions.length > 0 && (this.recentExceptions[0] as number) < cutoff) {
      this.recentExceptions.shift();
    }
    const value = this.recentExceptions.length;
    if (value < rule.threshold) return;
    if (this.inCooldown(index, nowMs)) return;
    this.lastFiredAt.set(index, nowMs);
    await this.dispatch(this.buildRatePayload(rule, value, rule.threshold, nowMs));
  }

  /** Find a configured rule of `type` with its array index, or `null`. */
  private findRule<T extends AlertRule['type']>(
    type: T,
  ): { rule: Extract<AlertRule, { type: T }>; index: number } | null {
    for (let index = 0; index < this.deps.alerts.rules.length; index++) {
      const rule = this.deps.alerts.rules[index];
      if (rule !== undefined && rule.type === type) {
        return { rule: rule as Extract<AlertRule, { type: T }>, index };
      }
    }
    return null;
  }

  private inCooldown(index: number, nowMs: number): boolean {
    const last = this.lastFiredAt.get(index);
    if (last === undefined) return false;
    return nowMs - last < this.deps.alerts.cooldownMs;
  }

  /** Composite cooldown key so each flush rule keeps an independent per-family clock. */
  private cooldownKey(ruleType: 'new-exception' | 'every-exception', familyHash: string): string {
    return `${ruleType}|${familyHash}`;
  }

  private familyInCooldown(
    ruleType: 'new-exception' | 'every-exception',
    familyHash: string,
    nowMs: number,
  ): boolean {
    const last = this.lastFiredFamily.get(this.cooldownKey(ruleType, familyHash));
    if (last === undefined) return false;
    return nowMs - last < this.deps.alerts.cooldownMs;
  }

  private buildRatePayload(
    rule: AlertRule,
    value: number,
    threshold: number,
    nowMs: number,
  ): AlertPayload {
    return {
      rule,
      value,
      threshold,
      firedAt: new Date(nowMs).toISOString(),
      instanceId: this.deps.alerts.instanceId,
      ...(this.deps.alerts.dashboardUrl !== null
        ? { dashboardUrl: this.deps.alerts.dashboardUrl }
        : {}),
    };
  }

  /**
   * Build the rich exception payload shared by `new-exception` and
   * `every-exception`. Reads the exception entry's own fields (server vs client),
   * then — when a `geoLookup` hook is configured and a client IP is present —
   * resolves the IP to a coarse location. Geo runs ONLY on a real fire.
   */
  private async buildExceptionPayload(
    rule: AlertRule,
    entry: Entry,
    occurrences: number,
    nowMs: number,
  ): Promise<AlertPayload> {
    const exception = buildExceptionContext(entry, occurrences);
    exception.geo = await this.resolveGeo(exception.clientIp);
    return {
      rule,
      value: occurrences,
      threshold: 1,
      firedAt: new Date(nowMs).toISOString(),
      instanceId: this.deps.alerts.instanceId,
      exception,
      ...(this.deps.alerts.dashboardUrl !== null
        ? { dashboardUrl: this.deps.alerts.dashboardUrl }
        : {}),
    };
  }

  /**
   * Resolve a client IP to a coarse {@link AlertGeoLocation} via the host's
   * `geoLookup` hook. Returns `null` when no hook is configured, no IP is present,
   * the hook returns `null`, or the hook throws (swallowed — geo is purely
   * additive and must never break or block an alert beyond the hook's own cost).
   */
  private async resolveGeo(clientIp: string | null): Promise<AlertGeoLocation | null> {
    const hook = this.deps.alerts.geoLookup;
    if (typeof hook !== 'function' || clientIp === null) return null;
    try {
      return (await hook(clientIp)) ?? null;
    } catch (error: unknown) {
      this.logger(`Telescope alert geoLookup failed: ${asMessage(error)}`);
      return null;
    }
  }

  /**
   * Fan the payload out to every channel concurrently. Each channel's failure is
   * isolated (`Promise.allSettled`) and warn-logged ONCE per channel name so a
   * persistently-down destination doesn't flood the logs. Never rejects.
   */
  private async dispatch(payload: AlertPayload): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.alerts.channels.map((channel) => channel.send(payload)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.warnChannelFailure(this.deps.alerts.channels[index], result.reason);
      }
    });
  }

  private warnChannelFailure(channel: AlertChannel | undefined, reason: unknown): void {
    if (channel === undefined) return;
    if (this.warnedChannels.has(channel.name)) return;
    this.warnedChannels.add(channel.name);
    this.logger(`Telescope alert channel '${channel.name}' failed: ${asMessage(reason)}`);
  }
}

/**
 * Build the rich exception context from an exception {@link Entry}, branching on
 * whether it's a browser-reported `client_exception` or a server exception. Client
 * exceptions carry their own IP (server-filled at ingest, NEVER from the body),
 * user-agent, React component stack, and free-form `extra`; server exceptions
 * carry route/method from the recorded request context. `geo` is left `null` here
 * and resolved async by the alerter only on a real fire.
 */
function buildExceptionContext(entry: Entry, occurrences: number): ExceptionAlertContext {
  const content = asContentRecord(entry.content);
  const client = entry.type === EntryType.ClientException;
  const base = {
    familyHash: entry.familyHash ?? '',
    class: pickString(content, ['class', 'name']) ?? 'Error',
    message: pickString(content, ['message']) ?? '',
    stack: clipStackFrames(pickString(content, ['stack']) ?? null),
    route: pickString(content, ['route', 'uri', 'url']),
    statusCode: pickNumber(content, ['statusCode', 'status']),
    geo: null,
    durationMs: pickNumber(content, ['durationMs']),
    user: userFromTags(entry.tags),
    occurrences,
    // First occurrence of the family in the window vs a recurrence.
    isNew: occurrences === 1,
    entryId: entry.id,
  };
  if (client) {
    return {
      ...base,
      method: null,
      userAgent: pickString(content, ['userAgent']),
      referer: null,
      componentStack: pickString(content, ['componentStack']),
      extra: pickRecord(content, ['extra']),
      client: true,
      // Server-filled at ingest (client_errors validation), never from the body.
      clientIp: pickString(content, ['clientIp']),
    };
  }
  return {
    ...base,
    method: pickString(content, ['method']),
    userAgent: pickString(content, ['userAgent']),
    referer: pickString(content, ['referer', 'referrer']),
    componentStack: null,
    extra: null,
    client: false,
    clientIp: pickString(content, ['ip', 'clientIp']),
  };
}

function asContentRecord(content: unknown): Record<string, unknown> {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : {};
}

/** First string-valued field among `keys`, or `null`. */
function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** First number-valued field among `keys`, or `null`. */
function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

/** First plain-object field among `keys`, or `null`. */
function pickRecord(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/** Keep at most the first N stack frames; `null` passes through. */
function clipStackFrames(stack: string | null): string | null {
  if (stack === null) return null;
  return stack.split('\n').slice(0, ALERT_STACK_FRAME_LIMIT).join('\n');
}

/** Extract the user id from a `user:<id>` tag, or `null` when none is present. */
function userFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('user:')) {
      return tag.slice('user:'.length);
    }
  }
  return null;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
