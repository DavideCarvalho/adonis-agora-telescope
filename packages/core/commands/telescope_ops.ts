import { readFile } from 'node:fs/promises';
import { args, flags } from '@adonisjs/core/ace';
import { consoleMeta, QUEUE_ACTIONS_DISABLED } from '../src/ui/console_apis.js';
import { consoleTenantScope, describeTenantScope } from '../src/ui/tenant_scope.js';
import { ConsoleRefusal, cell, cliActor, TelescopeCommand } from './shared.js';

/** A JSON flag: inline JSON, or `@path/to/file.json`. Exported for tests. */
export async function jsonFlag(value: string, name: string): Promise<unknown> {
  const text = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${name} must be JSON (inline, or @file.json)`);
  }
}

/** `telescope:requests:replay`: re-issue a captured request against the local server. */
export class TelescopeRequestsReplay extends TelescopeCommand {
  static override commandName = 'telescope:requests:replay';
  static override description =
    'Re-issue a captured request against the local server (needs telescope_ui replay.enabled)';

  @args.string({ description: 'Request entry id' })
  declare id: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const { apis, uiConfig } = await this.console();
    // The handler refuses when replay is off; asking first would be pointless then.
    if (uiConfig.replay.enabled) {
      const question = `Replay request ${this.id} against the app (it may write)?`;
      if (!(await this.confirmed(this.force, question))) return;
    }
    const body = await this.handle((ctx) => apis.api.replayRequest(ctx, this.id));
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>);
  }
}

/** `telescope:schedules:list`: the console's Live Schedules (registered tasks + last run). */
export class TelescopeSchedulesList extends TelescopeCommand {
  static override commandName = 'telescope:schedules:list';
  static override description = 'Registered schedules with their next run and last run';

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.schedulesApi.live(ctx));
    if (this.json) return this.printJson(body);
    const { tasks } = body.data as { tasks: Array<Record<string, unknown>> };
    this.table(tasks, [
      'name',
      'kind',
      'schedule',
      'nextRunAt',
      'lastRunAt',
      'lastStatus',
      'lastDurationMs',
    ]);
  }
}

/** `telescope:queues:list`: the console's live Queue Manager (queues, counts, capabilities). */
export class TelescopeQueuesList extends TelescopeCommand {
  static override commandName = 'telescope:queues:list';
  static override description = 'Live queues with their job counts and supported actions';

  override async run() {
    const { apis, uiConfig } = await this.console();
    const body = await this.handle((ctx) =>
      apis.queueManagerApi.list(ctx, uiConfig.queueActions.enabled),
    );
    if (this.json) return this.printJson(body);
    const { queues, capabilities } = body.data as {
      queues: Array<Record<string, unknown>>;
      capabilities: { mutationsEnabled: boolean; actions: string[] };
    };
    this.renderObject({ queues } as Record<string, unknown>, 100);
    this.logger.info(
      `actions: ${capabilities.actions.join(', ') || 'none'} (${capabilities.mutationsEnabled ? 'enabled' : 'disabled: telescope_ui queueActions.enabled'})`,
    );
  }
}

/** `telescope:jobs:show`: one live job. */
export class TelescopeJobsShow extends TelescopeCommand {
  static override commandName = 'telescope:jobs:show';
  static override description = 'One live job: state, attempts, payload, error';

  @args.string({ description: 'Queue name' })
  declare queue: string;

  @args.string({ description: 'Job id' })
  declare id: string;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.queueManagerApi.job(ctx, this.queue, this.id));
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>);
  }
}

/** Queue mutations stay behind `telescope_ui.queueActions.enabled`, like the console's. */
abstract class QueueMutationCommand extends TelescopeCommand {
  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  protected async gate(question: string): Promise<boolean> {
    const { uiConfig } = await this.console();
    if (!uiConfig.queueActions.enabled) throw new ConsoleRefusal(403, QUEUE_ACTIONS_DISABLED);
    return this.confirmed(this.force, question);
  }
}

/** `telescope:jobs:retry`: retry a failed job. */
export class TelescopeJobsRetry extends QueueMutationCommand {
  static override commandName = 'telescope:jobs:retry';
  static override description = 'Retry a failed job (needs telescope_ui queueActions.enabled)';

  @args.string({ description: 'Queue name' })
  declare queue: string;

  @args.string({ description: 'Job id' })
  declare id: string;

  override async run() {
    if (!(await this.gate(`Retry job ${this.id} on ${this.queue}?`))) return;
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.queueManagerApi.retry(ctx, this.queue, this.id));
    if (this.json) return this.printJson(body);
    this.logger.success(`job ${this.id} on ${this.queue} queued for retry`);
  }
}

/** `telescope:jobs:enqueue`: add a job to a queue. */
export class TelescopeJobsEnqueue extends QueueMutationCommand {
  static override commandName = 'telescope:jobs:enqueue';
  static override description = 'Add a job to a queue (needs telescope_ui queueActions.enabled)';

  @args.string({ description: 'Queue name' })
  declare queue: string;

  @flags.string({ description: 'Job payload: JSON, or @file.json', required: true })
  declare payload: string;

  @flags.string({ description: 'Job name', flagName: 'name' })
  declare jobName?: string;

  override async run() {
    const payload = await jsonFlag(this.payload, 'payload');
    if (!(await this.gate(`Enqueue a job on ${this.queue}?`))) return;
    const { apis } = await this.console();
    const body = await this.handle((ctx) =>
      apis.queueManagerApi.enqueue(ctx, this.queue, {
        payload,
        ...(this.jobName ? { name: this.jobName } : {}),
      }),
    );
    if (this.json) return this.printJson(body);
    this.logger.success(`enqueued on ${this.queue}: ${cell(body.data)}`);
  }
}

/** `telescope:profiles:status`: whether CPU profiling is installed and how it samples. */
export class TelescopeProfilesStatus extends TelescopeCommand {
  static override commandName = 'telescope:profiles:status';
  static override description = 'CPU profiling: installed, enabled, sampling';

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.profilesApi.status(ctx));
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>);
  }
}

/** `telescope:profiles:list`: captured CPU profiles, newest first. */
export class TelescopeProfilesList extends TelescopeCommand {
  static override commandName = 'telescope:profiles:list';
  static override description = 'Captured CPU profiles, newest first (cursor paging)';

  @flags.string({ description: 'Page size (default 100)' })
  declare first?: string;

  @flags.string({ description: 'Cursor: continue after this meta.nextCursor' })
  declare after?: string;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.profilesApi.list(ctx), {
      ...(this.first !== undefined ? { first: this.first } : {}),
      ...(this.after ? { after: this.after } : {}),
    });
    if (this.json) return this.printJson(body);
    this.table(body.data as Array<Record<string, unknown>>, [
      'id',
      'createdAt',
      'durationMs',
      'traceId',
      'summary',
    ]);
    const meta = body.meta as { nextCursor: string | null };
    if (meta.nextCursor) this.logger.info(`next page: --after ${meta.nextCursor}`);
  }
}

/** `telescope:profiles:show`: one CPU profile (`--json` for the full V8 profile). */
export class TelescopeProfilesShow extends TelescopeCommand {
  static override commandName = 'telescope:profiles:show';
  static override description = 'One CPU profile (--json prints the whole V8 profile)';

  @args.string({ description: 'Profile entry id' })
  declare id: string;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.profilesApi.show(ctx, this.id));
    if (this.json) return this.printJson(body);
    const entry = body.data as Record<string, unknown>;
    const content = (entry.content ?? {}) as Record<string, unknown>;
    const { profile: _profile, ...summary } = content;
    this.renderObject({
      id: entry.id,
      createdAt: entry.createdAt,
      durationMs: entry.durationMs,
      traceId: entry.traceId,
      ...summary,
    });
  }
}

/** `telescope:tenants:list`: the organizations the console's picker offers. */
export class TelescopeTenantsList extends TelescopeCommand {
  static override commandName = 'telescope:tenants:list';
  static override description = 'Organizations telescope has entries for (tenancy on)';

  override async run() {
    const { coreConfig, store } = await this.console();
    const scope = consoleTenantScope({ tenants: '*' }, coreConfig.tenancy);
    const data = await describeTenantScope(scope, coreConfig.tenancy, store);
    if (this.json) return this.printJson({ data });
    if (!data.enabled) {
      this.logger.info('tenancy is off: entries are not tagged by organization');
      return;
    }
    this.table(data.tenants as unknown as Array<Record<string, unknown>>, ['id', 'label']);
  }
}

/** `telescope:meta:show`: what the console turns on (features, watchers, extensions). */
export class TelescopeMetaShow extends TelescopeCommand {
  static override commandName = 'telescope:meta:show';
  static override description =
    'Features that are on (AI, profiling, queue manager), running watchers, extension contributions';

  override async run() {
    const { apis } = await this.console();
    const data = consoleMeta(apis);
    if (this.json) return this.printJson({ data });
    this.renderObject(data);
  }
}

/** `telescope:ext:data`: resolve an extension's data provider (what its dashboard panel shows). */
export class TelescopeExtData extends TelescopeCommand {
  static override commandName = 'telescope:ext:data';
  static override description = "Resolve an extension's dashboard data provider";

  @args.string({ description: 'Extension id' })
  declare ext: string;

  @args.string({ description: 'Data provider name' })
  declare provider: string;

  @flags.array({ description: 'Query parameter key=value (repeat)' })
  declare param?: string[];

  override async run() {
    const { apis } = await this.console();
    const extApi = apis.extApi;
    if (extApi === null) throw new ConsoleRefusal(404, 'No telescope extension is configured.');
    const qs: Record<string, unknown> = {};
    for (const pair of this.param ?? []) {
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error('--param must be key=value');
      qs[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const body = await this.handle((ctx) => extApi.data(ctx, this.ext, this.provider), qs);
    this.printJson(body);
  }
}

/** `telescope:ext:action`: run an extension action, audited as `cli:<user>`. */
export class TelescopeExtAction extends TelescopeCommand {
  static override commandName = 'telescope:ext:action';
  static override description = 'Run an extension action (audited; asks unless --force)';

  @args.string({ description: 'Extension id' })
  declare ext: string;

  @args.string({ description: 'Action name' })
  declare action: string;

  @flags.string({ description: 'Action input: JSON object, or @file.json' })
  declare input?: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    this.refuseScoped('An extension action');
    const input = this.input !== undefined ? await jsonFlag(this.input, 'input') : {};
    const { apis } = await this.console();
    const extApi = apis.extApi;
    if (extApi === null) throw new ConsoleRefusal(404, 'No telescope extension is configured.');
    if (!(await this.confirmed(this.force, `Run ${this.ext}/${this.action}?`))) return;
    const body = await this.handle((ctx) =>
      extApi.action(ctx, this.ext, this.action, { confirmed: true, input }, cliActor()),
    );
    this.printJson(body);
  }
}
