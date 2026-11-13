import { userInfo } from 'node:os';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { durationToMs } from '../src/alerts/parse_duration.js';
import { type ResolvedTelescopeConfig, resolveConfig } from '../src/define_config.js';
import { buildTelescopeTools, type TelescopeTools } from '../src/dev_tools/telescope_tools.js';
import { getTelescopeRuntime } from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';
import { TenantScopedStore } from '../src/tenancy_store.js';
import {
  buildConsoleApis,
  type ConsoleApis,
  recordExtensionAction,
} from '../src/ui/console_apis.js';
import {
  type ResolvedTelescopeUiConfig,
  resolveConfig as resolveUiConfig,
  type TelescopeUiConfig,
} from '../src/ui/define_config.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../src/ui/http.js';
import { consoleTenantScope, selectTenantScope } from '../src/ui/tenant_scope.js';

/** Who a command acts as in audit records: `cli:<os user>`. */
export function cliActor(): { id: string } {
  let name = 'unknown';
  try {
    name = userInfo().username;
  } catch {
    // containers without a passwd entry
  }
  return { id: `cli:${name}` };
}

/** A console answer that is not 2xx, as one line: `404: Entry not found`. */
export class ConsoleRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${status}: ${message}`);
  }
}

/** What a command runs against: the console's handlers and the dev tools, over one scope. */
export interface TelescopeConsole {
  /** The whole store (global actions: prune, clear). */
  store: TelescopeStore;
  /** The store the reads see: the whole store, or one organization's slice (`--tenant`). */
  source: TelescopeStore;
  /** Whether `--tenant` narrowed the reads. */
  scoped: boolean;
  apis: ConsoleApis;
  tools: TelescopeTools;
  coreConfig: ResolvedTelescopeConfig;
  uiConfig: ResolvedTelescopeUiConfig;
}

/**
 * Base for every `telescope:*` command. Boots the app (no server, no workers), then runs the SAME
 * handlers the console's `<path>/api/*` routes run (and the `telescope_*` dev tools), so the gates
 * (`replay.enabled`, `queueActions.enabled`, …), validation and audit are the console's. A shell on
 * the host is trusted like a console viewer allowed every organization; `--tenant` narrows to one.
 */
export abstract class TelescopeCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.string({ description: 'Only this organization (when tenancy is on)' })
  declare tenant?: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  /**
   * A refused call (not found, disabled, bad input) is one error line and exit code 1, not a stack
   * trace. Programming errors keep their stack.
   */
  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  private resolved: TelescopeConsole | undefined;

  /** The console over the booted store, scoped by `--tenant`. */
  protected async console(): Promise<TelescopeConsole> {
    if (this.resolved !== undefined) return this.resolved;
    const store = getTelescopeRuntime().store;
    if (store === null) {
      throw new Error(
        'telescope is not running in this app (is it enabled in config/telescope.ts?)',
      );
    }
    const coreConfig = resolveConfig(this.app.config.get('telescope', {}));
    const uiConfig = resolveUiConfig(
      this.app.config.get<TelescopeUiConfig | undefined>('telescope_ui', undefined),
      { inProduction: this.app.inProduction === true },
    );
    let source = store;
    let scoped = false;
    if (this.tenant !== undefined && this.tenant !== '') {
      const scope = consoleTenantScope({ tenants: '*' }, coreConfig.tenancy);
      if (scope === null) throw new Error('--tenant needs tenancy (it is off in this app)');
      const { tags } = selectTenantScope(scope, this.tenant, coreConfig.tenancy);
      if (tags !== null) {
        source = new TenantScopedStore(store, tags);
        scoped = true;
      }
    }
    const logger = await this.app.container.make('logger').catch(() => null);
    const apis = buildConsoleApis(source, {
      coreConfig,
      uiConfig,
      container: { make: (token) => this.app.container.make(token as never) },
      audit: (record) =>
        recordExtensionAction(
          store,
          record,
          logger as unknown as { info(obj: unknown, msg?: string): void } | null,
        ),
    });
    this.resolved = {
      store,
      source,
      scoped,
      apis,
      tools: buildTelescopeTools(source, coreConfig),
      coreConfig,
      uiConfig,
    };
    return this.resolved;
  }

  /**
   * Run one console handler with `qs` as its query string; its JSON body, or a
   * {@link ConsoleRefusal} for a non-2xx answer.
   */
  protected async handle(
    handler: (ctx: UiHttpContext) => unknown,
    qs: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = new RecordingResponse();
    await handler({ request: makeRequest('GET', qs), response });
    const body = (response.body ?? {}) as Record<string, unknown>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ConsoleRefusal(
        response.statusCode,
        typeof body.error === 'string' ? body.error : 'refused',
      );
    }
    return body;
  }

  /** Refuse an action that reaches every organization when `--tenant` narrowed the command. */
  protected refuseScoped(what: string): void {
    if (this.tenant !== undefined && this.tenant !== '') {
      throw new Error(`${what} reaches every organization: run it without --tenant`);
    }
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /**
   * Destructive actions ask first. `--force` skips the question; without a terminal (CI, a pipe)
   * there is nobody to ask, so the command refuses unless `--force`.
   */
  protected async confirmed(force: boolean | undefined, question: string): Promise<boolean> {
    if (force) return true;
    if (process.stdin.isTTY !== true) {
      throw new Error(`${question.replace(/\?$/, '')}: needs confirmation, pass --force`);
    }
    if (await this.prompt.confirm(question)) return true;
    this.logger.warning('cancelled');
    this.exitCode = 1;
    return false;
  }

  /** A table of rows (objects): the given columns, `''` for a missing value. */
  protected table(rows: Array<Record<string, unknown>>, columns: string[]): void {
    if (rows.length === 0) {
      this.logger.info('nothing to show');
      return;
    }
    const table = this.ui.table();
    table.head(columns);
    for (const row of rows) table.row(columns.map((c) => cell(row[c])));
    table.render();
  }

  /**
   * A generic object as tables: its scalar fields as one Field/Value table, each list of objects as
   * its own table (titled by its key), nested objects flattened one level.
   */
  protected renderObject(value: Record<string, unknown>, maxRows = 20): void {
    const scalars: Array<[string, string]> = [];
    const lists: Array<[string, Array<Record<string, unknown>>]> = [];
    const visit = (prefix: string, object: Record<string, unknown>, depth: number) => {
      for (const [key, v] of Object.entries(object)) {
        const name = prefix === '' ? key : `${prefix}.${key}`;
        if (Array.isArray(v)) {
          if (v.length > 0 && v.every((i) => isPlainObject(i))) {
            lists.push([name, v as Array<Record<string, unknown>>]);
          } else {
            scalars.push([name, v.map(cell).join(', ')]);
          }
        } else if (isPlainObject(v) && depth < 1) {
          visit(name, v, depth + 1);
        } else {
          scalars.push([name, cell(v)]);
        }
      }
    };
    visit('', value, 0);
    if (scalars.length > 0) {
      const table = this.ui.table();
      table.head(['Field', 'Value']);
      for (const [k, v] of scalars) table.row([k, v]);
      table.render();
    }
    for (const [name, rows] of lists) {
      this.logger.log('');
      this.logger.info(
        `${name}${rows.length > maxRows ? ` (first ${maxRows} of ${rows.length})` : ''}`,
      );
      const columns = [
        ...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !isPlainObject(r[k])))),
      ].slice(0, 8);
      this.table(rows.slice(0, maxRows), columns);
    }
  }
}

/** Abstract base for commands over a trailing window (`--window 1h`). */
export abstract class WindowCommand extends TelescopeCommand {
  @flags.string({ description: 'Trailing window, e.g. 15m, 1h, 1d' })
  declare window?: string;

  protected windowMs(): number | undefined {
    return this.window !== undefined ? durationToMs(this.window) : undefined;
  }
}

/** A `--since`/`--until` value: a duration ago (`15m`, `2h`) or an instant (ISO-8601). */
export function instantFlag(value: string, name: string): string {
  if (/^\d+(ms|s|m|h|d)$/.test(value.trim())) {
    return new Date(Date.now() - durationToMs(value.trim())).toISOString();
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`--${name} must be a duration (15m, 2h) or an ISO date`);
  return new Date(ms).toISOString();
}

/** An integer flag; refuses junk instead of guessing. */
export function intFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One table cell: dates as ISO, objects as compact JSON, long text cut. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  }
  const text = String(value);
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}
