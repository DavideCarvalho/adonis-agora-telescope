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
 * Grouping key for "the same query". With `normalize` on (the default) the SQL is
 * templated first, so every execution of the same shape shares a hash regardless
 * of bound values; with it off the raw SQL is hashed verbatim (whitespace/literals
 * distinguish entries — no cross-execution grouping).
 */
export function queryFamilyHash(sql: string, normalize = true): string {
  return fnv1a(normalize ? normalizeSql(sql) : sql);
}
