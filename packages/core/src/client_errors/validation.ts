/**
 * A browser-reported error ingested via the public client-error endpoint (see
 * {@link EntryType.ClientException}). Everything beyond `message` is optional
 * because the browser is UNTRUSTED — {@link validateClientErrorBody} validates
 * the structure and length-caps the strings before recording, and `extra` (an
 * arbitrary, host-defined bag of debugging context) is bounded by the normal
 * redaction budget at record time exactly like every other content payload.
 *
 * Field intent mirrors the NestJS `nestjs-telescope` core:
 *  - `message`        — the error message (required; the one field we insist on).
 *  - `name`           — the error class/name (e.g. `TypeError`); feeds the family hash.
 *  - `stack`          — the JS stack string; its TOP frame also feeds the family hash.
 *  - `componentStack` — React's component stack (from an error boundary).
 *  - `url`            — the page URL where the error happened.
 *  - `userAgent`      — the reporting browser's UA string.
 *  - `user`           — host-supplied user identity (pivoted into a `user:<id>` tag).
 *  - `release`        — an app version / build id, so errors group by deploy.
 *  - `extra`          — free-form debugging context; redacted/bounded like any content.
 *  - `clientIp`       — filled in BY THE SERVER from `request.ip()`; never from the body.
 */
export interface ClientExceptionContent {
  message: string;
  name: string | null;
  stack: string | null;
  componentStack: string | null;
  url: string | null;
  userAgent: string | null;
  user: unknown;
  release: string | null;
  extra: Record<string, unknown> | null;
  clientIp: string | null;
}

/**
 * Length caps for the validated string fields. The browser is UNTRUSTED, so we
 * bound every string before recording — a stack can be large but not unbounded,
 * and short fields (message/url/userAgent) get a tight cap. Arrays/objects under
 * `extra` are NOT capped here; they pass through the redaction budget
 * (depth/string/array/node bounds) at record time exactly like all other content.
 */
const STACK_MAX = 16 * 1024;
const COMPONENT_STACK_MAX = 16 * 1024;
const MESSAGE_MAX = 2 * 1024;
const SHORT_FIELD_MAX = 2 * 1024;
const NAME_MAX = 256;
const RELEASE_MAX = 256;

/**
 * The successful parse result. We DELIBERATELY do not echo the raw payload back
 * to the client on failure (see {@link validateClientErrorBody}) — the caller
 * gets a generic 400 with a fixed reason, never a reflection of what it sent.
 */
export type ClientErrorValidation =
  | { ok: true; value: Omit<ClientExceptionContent, 'clientIp'> }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an OPTIONAL string field: missing/`null`/`undefined` yields `null`; a
 * present non-string is a hard validation failure (we don't silently coerce
 * untrusted input); a present string is length-capped.
 */
function optionalString(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, reason: `\`${field}\` must be a string` };
  return { ok: true, value: value.length > max ? value.slice(0, max) : value };
}

/**
 * Structurally validate an UNTRUSTED client-error body WITHOUT adding a schema
 * dependency. Rules: `message` is a required non-empty string; every other field
 * is optional with a type check and a length cap; `user` is passed through as-is
 * (redacted at record time) and `extra` must be a plain object if present (its
 * contents are bounded by redaction, not here). On any violation returns a
 * generic reason and NO echo of the payload, so the endpoint never reflects
 * attacker input.
 */
export function validateClientErrorBody(body: unknown): ClientErrorValidation {
  if (!isRecord(body)) {
    return { ok: false, reason: 'Body must be a JSON object' };
  }
  const message = body.message;
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, reason: '`message` is required and must be a non-empty string' };
  }
  const cappedMessage = message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message;

  const name = optionalString(body.name, 'name', NAME_MAX);
  if (!name.ok) return name;
  const stack = optionalString(body.stack, 'stack', STACK_MAX);
  if (!stack.ok) return stack;
  const componentStack = optionalString(body.componentStack, 'componentStack', COMPONENT_STACK_MAX);
  if (!componentStack.ok) return componentStack;
  const url = optionalString(body.url, 'url', SHORT_FIELD_MAX);
  if (!url.ok) return url;
  const userAgent = optionalString(body.userAgent, 'userAgent', SHORT_FIELD_MAX);
  if (!userAgent.ok) return userAgent;
  const release = optionalString(body.release, 'release', RELEASE_MAX);
  if (!release.ok) return release;

  let extra: Record<string, unknown> | null = null;
  if (body.extra !== undefined && body.extra !== null) {
    if (!isRecord(body.extra)) {
      return { ok: false, reason: '`extra` must be an object' };
    }
    extra = body.extra;
  }

  return {
    ok: true,
    // Field ORDER is load-bearing: the Recorder's content-byte budget drops keys
    // in insertion order, so the short enrichment fields (url/userAgent) lead and
    // the multi-KB `stack`/`componentStack` come LAST — otherwise a deep error
    // boundary's stack starves the short fields the alert renders. The ingestor
    // re-asserts this order (with server-derived clientIp first) at record time.
    value: {
      message: cappedMessage,
      name: name.value,
      url: url.value,
      userAgent: userAgent.value,
      // `user` is intentionally untyped passthrough: redacted at record time and
      // pivoted into a `user:<id>` tag via userIdentityTag.
      user: 'user' in body ? body.user : null,
      release: release.value,
      extra,
      stack: stack.value,
      componentStack: componentStack.value,
    },
  };
}

/**
 * The `user:<id>` tag for a raw user value, or `null` when no usable identity is
 * present. Prefers `id`, then `_id`, then `email` — so an error reported from a
 * browser tags identically to a server request. Cheap property reads; never throws.
 * Ported from the `nestjs-telescope` tagger's `userIdentityTag`.
 */
export function userIdentityTag(user: unknown): string | null {
  if (typeof user !== 'object' || user === null) return null;
  const record = user as Record<string, unknown>;
  const id = identityToken(record.id) ?? identityToken(record._id) ?? identityToken(record.email);
  return id === null ? null : `user:${id}`;
}

function identityToken(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return null;
}
