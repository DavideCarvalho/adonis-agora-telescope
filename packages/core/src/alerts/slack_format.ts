import type { AlertGeoLocation, AlertPayload } from './alert_rule.js';

/**
 * Optional Slack presentation overrides. Most hosts set none of these — the
 * incoming webhook's own default name/icon is used. Provided for hosts that route
 * several Telescope instances into one channel and want them visually distinct.
 */
export interface SlackChannelOptions {
  /** Override the bot username shown on the message. */
  username?: string;
  /** Override the message icon (a Slack emoji shortcode, e.g. `:rotating_light:`). */
  iconEmoji?: string;
}

/**
 * Slack hard limits we format within. A `text` field in a section is capped at
 * 3000 chars; we keep the stack snippet WELL under that and additionally cap by
 * frame count so the message stays scannable rather than a wall of frames.
 */
const STACK_CHAR_LIMIT = 2_800;
const STACK_FRAME_LIMIT = 10;

/**
 * Slack caps a `section` block's `fields` array at 10 items — an 11th makes Slack
 * reject the WHOLE message with `400 invalid_blocks`. A fully-enriched exception
 * (instance + observed + error + route + UA + referer + duration + user + client
 * IP + location + occurrences) exceeds that, so we spread the fields across as
 * many section blocks as needed rather than overflowing one.
 */
const MAX_SECTION_FIELDS = 10;

/**
 * Chunk a flat list of Slack section fields into groups of at most
 * {@link MAX_SECTION_FIELDS}, so each becomes its own `section` block. Slack
 * rejects the WHOLE message with `400 invalid_blocks` if any single section
 * carries more than 10 fields, so this is what keeps a fully-enriched exception
 * alert deliverable. Exported for direct testing of the field-cap invariant.
 */
export function chunkContextFields<T>(fields: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < fields.length; i += MAX_SECTION_FIELDS) {
    chunks.push(fields.slice(i, i + MAX_SECTION_FIELDS));
  }
  return chunks;
}

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}
interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}
interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
}
interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url: string;
}
interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}
type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackActionsBlock;

/** The full webhook body Slack expects: a fallback `text` plus the rich `blocks`. */
export interface SlackMessage {
  /** Fallback/notification text shown where blocks can't render. */
  text: string;
  blocks: SlackBlock[];
  username?: string;
  icon_emoji?: string;
}

/**
 * Severity → leading emoji, derived from the rule kind: a brand-new error family
 * or an exception spike is the loudest signal an operator can get.
 */
function severityEmoji(rule: AlertPayload['rule']): string {
  if (
    rule.type === 'new-exception' ||
    rule.type === 'every-exception' ||
    rule.type === 'exception-rate'
  ) {
    return ':rotating_light:';
  }
  return ':warning:';
}

/** Short, human rule label for the header. */
function ruleLabel(rule: AlertPayload['rule']): string {
  switch (rule.type) {
    case 'new-exception':
      return 'New exception family';
    case 'every-exception':
      return 'Exception';
    case 'exception-rate':
      return 'Exception rate';
    case 'metric-threshold':
      return `Metric threshold (${rule.metric})`;
  }
}

/** Regional-indicator flag emoji for an ISO 3166-1 alpha-2 code, or `''`. */
function flagEmoji(countryCode: string | undefined): string {
  if (countryCode === undefined || !/^[A-Za-z]{2}$/.test(countryCode)) return '';
  const cc = countryCode.toUpperCase();
  const base = 0x1f1e6 - 65; // 'A' → 🇦
  return String.fromCodePoint(base + cc.charCodeAt(0), base + cc.charCodeAt(1));
}

/**
 * Render a coarse geo location as `🇺🇸 City, Region, Country`, skipping absent or
 * duplicate parts (a city equal to its region isn't repeated). Returns `null` when
 * there's nothing to show, so the caller omits the field entirely.
 */
function formatGeo(geo: AlertGeoLocation | null | undefined): string | null {
  if (!geo) return null;
  const parts: string[] = [];
  if (geo.city) parts.push(geo.city);
  if (geo.region && geo.region !== geo.city) parts.push(geo.region);
  if (geo.country && geo.country !== geo.region) parts.push(geo.country);
  if (parts.length === 0) return null;
  const flag = flagEmoji(geo.countryCode);
  return flag ? `${flag} ${parts.join(', ')}` : parts.join(', ');
}

/**
 * Clip an auxiliary code block (React component stack / serialized `extra`) to
 * Slack's per-section budget. Returns `null` for absent/empty input so the caller
 * omits the block rather than rendering an empty fence.
 */
function clipBlock(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text.trim() === '') return null;
  if (text.length <= STACK_CHAR_LIMIT) return text;
  return `${text.slice(0, STACK_CHAR_LIMIT)}…`;
}

/**
 * Best-effort pretty JSON for the `extra` bag. The Recorder already redacted +
 * depth-bounded it, but a circular ref could still slip through a host-built
 * object, so we fall back to a placeholder rather than throwing into formatting.
 */
function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

/** A Slack `mrkdwn` field pairing a bold label with a value. */
function field(label: string, value: string): SlackTextObject {
  return { type: 'mrkdwn', text: `*${label}:*\n${value}` };
}

/**
 * Clip a raw stack to Slack's budget: keep at most {@link STACK_FRAME_LIMIT}
 * lines, then hard-cap the joined string at {@link STACK_CHAR_LIMIT} chars.
 * Returns `null` for an absent stack so the caller can omit the block entirely.
 */
function clipStack(stack: string | null): string | null {
  if (stack === null || stack.trim() === '') return null;
  const frames = stack.split('\n').slice(0, STACK_FRAME_LIMIT).join('\n');
  if (frames.length <= STACK_CHAR_LIMIT) return frames;
  return `${frames.slice(0, STACK_CHAR_LIMIT)}…`;
}

/** A Slack section `text` field is capped at 3000 chars; keep the AI note under it. */
const DIAGNOSIS_CHAR_LIMIT = 2_800;

/**
 * Render the optional AI probable-cause summary as a Slack `mrkdwn` block body:
 * a bold "Probable cause (AI)" label with confidence, the cause, and — when
 * present — the suggested fix. Returns `null` when no diagnosis is attached, so
 * the caller omits the block entirely (an alert with AI off looks exactly as
 * before).
 */
function formatDiagnosis(diagnosis: AlertPayload['diagnosis']): string | null {
  if (diagnosis === undefined) return null;
  const cause = diagnosis.cause.trim();
  const fix = diagnosis.fix.trim();
  if (cause === '' && fix === '') return null;
  const lines = [`*Probable cause (AI):* _${diagnosis.confidence} confidence_`];
  if (cause !== '') lines.push(cause);
  if (fix !== '') lines.push('', `*Suggested fix:* ${fix}`);
  const text = lines.join('\n');
  return text.length <= DIAGNOSIS_CHAR_LIMIT ? text : `${text.slice(0, DIAGNOSIS_CHAR_LIMIT)}…`;
}

/**
 * Build the deep link to the offending exception entry in the host's external
 * dashboard. Returns `null` when no `dashboardUrl` is configured or there is no
 * entry id to link to (rate rules carry no single id).
 */
function dashboardLink(payload: AlertPayload): string | null {
  const { dashboardUrl, exception } = payload;
  if (dashboardUrl === undefined || exception === undefined) return null;
  const base = dashboardUrl.replace(/\/+$/, '');
  return `${base}#/entries/view/${exception.entryId}`;
}

/**
 * Render an {@link AlertPayload} into a Slack Block Kit message. Structure:
 *  - a `header` with the severity emoji + rule label;
 *  - a `section` whose fields carry the instance/rule context (and — for
 *    `new-exception` — route/method/status/user and the occurrence count);
 *  - a `section` with a fenced code block of the truncated stack (only when an
 *    exception stack is present);
 *  - an `actions` block with a single "Open in Telescope" button (only when a
 *    `dashboardUrl` + entry id are available to build the deep link).
 *
 * Everything degrades gracefully: a rate rule (no `exception` context) simply
 * renders the header + context fields and skips the stack/button.
 */
export function formatSlackMessage(
  payload: AlertPayload,
  options?: SlackChannelOptions,
): SlackMessage {
  // A stateful metric-threshold that has cleared renders as a green "Resolved"
  // card so the on-call sees the all-clear without hunting for a follow-up.
  const resolved = payload.status === 'resolved';
  const emoji = resolved ? ':white_check_mark:' : severityEmoji(payload.rule);
  const label = ruleLabel(payload.rule);
  // Badge a brand-new error family distinctly from a recurrence so on-call can
  // triage urgency at a glance. Only exceptions carry this; rate rules don't.
  const badge =
    payload.exception === undefined
      ? ''
      : payload.exception.isNew
        ? ' · 🆕 New'
        : ' · 🔁 Recurring';
  const headerText = `${emoji} ${resolved ? 'Resolved: ' : ''}${label}${badge}`;

  const contextFields: SlackTextObject[] = [
    field('Instance', payload.instanceId),
    field('Observed', `${payload.value} (threshold ${payload.threshold})`),
  ];

  const exception = payload.exception;
  if (exception !== undefined) {
    contextFields.push(field('Error', `${exception.class}: ${exception.message}`));
    if (exception.route !== null) {
      const method = exception.method ?? '';
      const status = exception.statusCode === null ? '' : ` → ${exception.statusCode}`;
      contextFields.push(field('Route', `${method} ${exception.route}${status}`.trim()));
    }
    if (exception.userAgent !== null) {
      contextFields.push(field('User agent', exception.userAgent));
    }
    if (exception.referer !== null) {
      contextFields.push(field('Referer', exception.referer));
    }
    if (exception.durationMs !== null) {
      contextFields.push(field('Duration', `${exception.durationMs} ms`));
    }
    if (exception.user !== null) {
      contextFields.push(field('User', exception.user));
    }
    if (exception.clientIp !== null) {
      contextFields.push(field('Client IP', exception.clientIp));
    }
    const geoText = formatGeo(exception.geo);
    if (geoText !== null) {
      contextFields.push(field('Location', geoText));
    }
    contextFields.push(field('Occurrences', `${exception.occurrences} in window`));
  } else {
    const window = 'window' in payload.rule ? payload.rule.window : null;
    if (window !== null) contextFields.push(field('Window', window));
  }

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
  ];
  // Spread the context fields across section blocks of at most MAX_SECTION_FIELDS —
  // one overflowing section makes Slack reject the entire message (invalid_blocks).
  for (const chunk of chunkContextFields(contextFields)) {
    blocks.push({ type: 'section', fields: chunk });
  }

  const diagnosisText = formatDiagnosis(payload.diagnosis);
  if (diagnosisText !== null) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: diagnosisText } });
  }

  const stack = exception ? clipStack(exception.stack) : null;
  if (stack !== null) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${stack}\`\`\`` } });
  }

  // React component stack (client_exception from an error boundary), when present.
  const componentStack = exception ? clipBlock(exception.componentStack) : null;
  if (componentStack !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Component stack:*\n\`\`\`${componentStack}\`\`\`` },
    });
  }

  // Host-defined free-form `extra` bag (client_exception), serialized as JSON.
  const extra =
    exception?.extra && Object.keys(exception.extra).length > 0
      ? clipBlock(safeJson(exception.extra))
      : null;
  if (extra !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Extra:*\n\`\`\`${extra}\`\`\`` },
    });
  }

  const link = dashboardLink(payload);
  if (link !== null) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Telescope', emoji: true },
          url: link,
        },
      ],
    });
  }

  return {
    text: headerText,
    blocks,
    ...(options?.username !== undefined ? { username: options.username } : {}),
    ...(options?.iconEmoji !== undefined ? { icon_emoji: options.iconEmoji } : {}),
  };
}
