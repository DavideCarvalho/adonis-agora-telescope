/**
 * The `schema` option of the SQL store: put telescope's tables in a database schema other
 * than the connection's (a Postgres schema, a MySQL database). Every statement the store
 * issues names the schema itself — never `SET search_path`, which leaks across clients
 * behind PgBouncer in transaction mode.
 */

const PKG = '@adonis-agora/telescope';

/** A schema name telescope accepts: a plain identifier that fits Postgres' 63-byte limit. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_SCHEMA_LENGTH = 63;

/** The Lucid dialects with no schemas to put a table in. */
const SCHEMALESS_DIALECTS = new Set(['sqlite3', 'better-sqlite3', 'libsql']);

/** Whether `dialect` is a Lucid MySQL dialect name (`mysql` / `mysql2`). */
export function isMysqlDialect(dialect: string | undefined): boolean {
  return dialect === 'mysql' || dialect === 'mysql2';
}

/** Whether `dialect` is Postgres or Redshift (both `CREATE SCHEMA IF NOT EXISTS`). */
function isPostgresDialect(dialect: string | undefined): boolean {
  return dialect === 'postgres' || dialect === 'redshift';
}

/**
 * Validate the `schema` option at boot: `undefined` passes through, anything else must be a
 * plain identifier of at most 63 characters on a dialect that has schemas. A dialect this
 * cannot tell (`undefined`) is let through: the first query names the schema anyway.
 */
export function validateSchema(
  schema: string | undefined,
  dialect: string | undefined,
  where: string,
): string | undefined {
  if (schema === undefined) return undefined;
  if (
    typeof schema !== 'string' ||
    !SCHEMA_NAME.test(schema) ||
    schema.length > MAX_SCHEMA_LENGTH
  ) {
    throw new Error(
      `${PKG}: ${where} \`schema\` must be a plain identifier (letters, digits, _ and $, not starting with a digit, at most ${MAX_SCHEMA_LENGTH} characters); got ${JSON.stringify(schema)}.`,
    );
  }
  if (dialect !== undefined && SCHEMALESS_DIALECTS.has(dialect)) {
    throw new Error(
      `${PKG}: ${where} sets \`schema: "${schema}"\`, but the connection is ${dialect}, which has no schemas. Remove \`schema\` or use a Postgres or MySQL connection.`,
    );
  }
  if (dialect !== undefined && !isMysqlDialect(dialect) && !isPostgresDialect(dialect)) {
    throw new Error(
      `${PKG}: ${where} sets \`schema: "${schema}"\`, but \`schema\` is supported on Postgres and MySQL only; the connection is ${dialect}.`,
    );
  }
  return schema;
}

/** Quote one identifier for `dialect`: backticks on MySQL, double quotes elsewhere. */
export function quoteIdentifier(identifier: string, dialect: string | undefined): string {
  return isMysqlDialect(dialect) ? `\`${identifier}\`` : `"${identifier}"`;
}

/** A table name for raw SQL: `"schema"."table"`, or just `"table"` without a schema. */
export function qualifiedSql(
  table: string,
  schema: string | undefined,
  dialect: string | undefined,
): string {
  const quoted = quoteIdentifier(table, dialect);
  return schema === undefined ? quoted : `${quoteIdentifier(schema, dialect)}.${quoted}`;
}

/**
 * A table name for Lucid's query builder: `schema.table`, which knex quotes as two
 * identifiers (`"schema"."table"`), or the bare table without a schema.
 */
export function qualifiedName(table: string, schema: string | undefined): string {
  return schema === undefined ? table : `${schema}.${table}`;
}

/** The rows of a Lucid `rawQuery` result, whatever the driver returned. */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    // mysql2 resolves `[rows, fields]`; sqlite resolves the rows themselves.
    return (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** The slice of a Lucid client {@link ensureSchema} needs. */
export interface RawQueryClient {
  rawQuery(sql: string, bindings?: unknown[]): Promise<unknown>;
}

/** Whether the schema exists, read from `information_schema` (Postgres and MySQL). */
export async function schemaExists(db: RawQueryClient, schema: string): Promise<boolean> {
  const rows = rowsOf(
    await db.rawQuery('SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ?', [
      schema,
    ]),
  );
  return rows.length > 0;
}

/** Whether `error` is a missing privilege (Postgres 42501, MySQL 1044 / 1142 / 1227). */
function isPermissionDenied(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return (
    code === '42501' ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    code === 'ER_TABLEACCESS_DENIED_ERROR' ||
    code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' ||
    errno === 1044 ||
    errno === 1142 ||
    errno === 1227
  );
}

/**
 * Create the schema when it is missing: `CREATE SCHEMA IF NOT EXISTS` on Postgres,
 * `CREATE DATABASE IF NOT EXISTS` on MySQL. The catalog is read first, so a role that may
 * use an existing schema but not create one boots fine. When the role cannot create it, the
 * error names the schema and the grant it needs.
 */
export async function ensureSchema(
  db: RawQueryClient,
  schema: string,
  dialect: string | undefined,
  runDdl: (statement: string) => Promise<void>,
): Promise<void> {
  const mysql = isMysqlDialect(dialect);
  if (!mysql && !isPostgresDialect(dialect)) {
    throw new Error(
      `${PKG}: cannot create the schema "${schema}": \`schema\` is supported on Postgres and MySQL only, and the connection's dialect is ${dialect ?? 'unknown'}.`,
    );
  }
  if (await schemaExists(db, schema)) return;
  const statement = mysql
    ? `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(schema, dialect)}`
    : `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, dialect)}`;
  try {
    await runDdl(statement);
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const grant = mysql
      ? `GRANT ALL ON \`${schema}\`.* TO <app user>`
      : `GRANT CREATE ON DATABASE <database> TO <app role> (or create it once: CREATE SCHEMA "${schema}" AUTHORIZATION <app role>)`;
    throw new Error(
      `${PKG}: cannot create the ${mysql ? 'database' : 'schema'} "${schema}": the connection's role is not allowed to. Create it beforehand or grant the role: ${grant}.`,
      { cause: error },
    );
  }
}
