/**
 * Grouping key for "the same SQL query" — same template, any bound values. Ported
 * from `nestjs-telescope`'s query family-hash so a dashboard can roll up every
 * execution of `select * from users where id = ?` regardless of the id.
 */

/**
 * Normalize an SQL string into a template: lowercase, collapse whitespace, and
 * replace string/number literals with `?` so only the query shape remains.
 */
function normalizeSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/g, '?') // string literals
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numeric literals
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 32-bit FNV-1a hash, hex-encoded. Deterministic across processes. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hashes of already-normalized SQL, keyed by the raw string. An app runs the same
 * few hundred parameterized statements over and over, and normalizing one is three
 * regex passes over the whole text — on every recorded query. The hash is a pure
 * function of the string, so a hit is exactly what recomputing would return.
 */
const normalizedHashes = new Map<string, string>();
const MAX_CACHED_SQL = 2_000;
const MAX_CACHED_SQL_LENGTH = 4_096;

/**
 * Grouping key for "the same query". With `normalize` on (the default) the SQL is
 * templated first, so every execution of the same shape shares a hash regardless
 * of bound values; with it off the raw SQL is hashed verbatim (whitespace/literals
 * distinguish entries — no cross-execution grouping).
 */
export function queryFamilyHash(sql: string, normalize = true): string {
  if (!normalize) return fnv1a(sql);
  const cached = normalizedHashes.get(sql);
  if (cached !== undefined) return cached;
  const hash = fnv1a(normalizeSql(sql));
  if (sql.length <= MAX_CACHED_SQL_LENGTH) {
    // Bounded: an app that inlines literals into its SQL produces endless distinct
    // strings, so start over rather than grow without limit.
    if (normalizedHashes.size >= MAX_CACHED_SQL) normalizedHashes.clear();
    normalizedHashes.set(sql, hash);
  }
  return hash;
}
