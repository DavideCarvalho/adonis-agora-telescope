const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS_PATTERN = /^\d+$/;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;

/** A path segment is an id when it is a UUID, all digits, or a long hex string. */
function isIdSegment(segment: string): boolean {
  return (
    UUID_PATTERN.test(segment) || ALL_DIGITS_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment)
  );
}

/**
 * Build a stable family for an OUTGOING HTTP call from a method + (possibly
 * absolute) url. Keeps the host and normalizes the path's id-like segments
 * (UUID / all-digits / long hex) to `:id`, so calls to the same external
 * endpoint group together regardless of ids.
 *
 * Ported from `nestjs-telescope`'s `query/normalize-route.ts`.
 *
 * @example
 *   normalizeHttpTarget('GET', 'https://api.stripe.com/v1/charges/ch_123?foo=1')
 *   // => 'GET api.stripe.com/v1/charges/:id'
 *
 * Falls back to normalizing the raw url (query string stripped) when it can't be
 * parsed as absolute (e.g. a relative target), so a family is always produced.
 */
export function normalizeHttpTarget(method: string, url: string): string {
  let host = '';
  let path = url;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    const queryStart = url.indexOf('?');
    path = queryStart === -1 ? url : url.slice(0, queryStart);
  }
  const normalizedPath = path
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${host}${normalizedPath}`;
}
