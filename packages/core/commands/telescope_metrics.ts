import { args, flags } from '@adonisjs/core/ace';
import { intFlag, TelescopeCommand, WindowCommand } from './shared.js';

/** `telescope:traces:list`: the console's Traces list, most recently active first. */
export class TelescopeTracesList extends TelescopeCommand {
  static override commandName = 'telescope:traces:list';
  static override description = 'List recent traces, most recently active first (cursor paging)';

  @flags.string({ description: 'Page size' })
  declare first?: string;

  @flags.string({ description: 'Cursor: the page after this meta.nextCursor' })
  declare after?: string;

  @flags.string({ description: 'Cursor: the page before this meta.prevCursor' })
  declare before?: string;

  override async run() {
    const { apis } = await this.console();
    const size = intFlag(this.first, 'first');
    const qs: Record<string, unknown> = this.before
      ? { before: this.before, ...(size !== undefined ? { last: size } : {}) }
      : {
          ...(this.after ? { after: this.after } : {}),
          ...(size !== undefined ? { first: size } : {}),
        };
    const body = await this.handle((ctx) => apis.api.metricsTraces(ctx), qs);
    if (this.json) return this.printJson(body);
    const rows = body.data as Array<Record<string, unknown>>;
    this.table(
      rows,
      [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
        (k) => typeof rows[0]?.[k] !== 'object' || rows[0]?.[k] === null,
      ),
    );
    const meta = body.meta as { nextCursor: string | null; prevCursor: string | null };
    if (meta.nextCursor) this.logger.info(`next page: --after ${meta.nextCursor}`);
    if (meta.prevCursor) this.logger.info(`previous page: --before ${meta.prevCursor}`);
  }
}

/** `telescope:traces:show`: every entry under one trace. */
export class TelescopeTracesShow extends TelescopeCommand {
  static override commandName = 'telescope:traces:show';
  static override description = 'Every entry recorded under one trace id';

  @args.string({ description: 'Trace id' })
  declare traceId: string;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.api.trace(ctx, this.traceId));
    if (this.json) return this.printJson(body);
    this.table(body.data as Array<Record<string, unknown>>, [
      'id',
      'type',
      'createdAt',
      'durationMs',
      'summary',
    ]);
  }
}

/** `telescope:traces:waterfall`: the span waterfall of one trace. */
export class TelescopeTracesWaterfall extends TelescopeCommand {
  static override commandName = 'telescope:traces:waterfall';
  static override description = 'The span waterfall of one trace (each operation as a span)';

  @args.string({ description: 'Trace id' })
  declare traceId: string;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.api.metricsWaterfall(ctx, this.traceId));
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 200);
  }
}

/** `telescope:traces:n-plus-one`: N+1 query loops within one trace. */
export class TelescopeTracesNPlusOne extends TelescopeCommand {
  static override commandName = 'telescope:traces:n-plus-one';
  static override description = 'N+1 query-loop patterns within one trace';

  @args.string({ description: 'Trace id' })
  declare traceId: string;

  @flags.string({ description: 'Repetitions that count as a loop' })
  declare threshold?: string;

  override async run() {
    const { apis } = await this.console();
    const threshold = intFlag(this.threshold, 'threshold');
    const body = await this.handle(
      (ctx) => apis.api.metricsNPlusOne(ctx, this.traceId),
      threshold !== undefined ? { threshold } : {},
    );
    if (this.json) return this.printJson(body);
    const rows = body.data as Array<Record<string, unknown>>;
    this.table(
      rows,
      Object.keys(rows[0] ?? {}).filter((k) => typeof rows[0]?.[k] !== 'object'),
    );
  }
}

/** `telescope:overview:show`: the console's Overview counters (total, top families, top tags). */
export class TelescopeOverviewShow extends TelescopeCommand {
  static override commandName = 'telescope:overview:show';
  static override description = 'Entry count, top families and top tags';

  @flags.string({ description: 'Rows per top list (default 10, max 50)' })
  declare limit?: string;

  @flags.string({ description: 'Only families of this entry type' })
  declare type?: string;

  override async run() {
    const { apis } = await this.console();
    const limit = intFlag(this.limit, 'limit');
    const body = await this.handle((ctx) => apis.api.stats(ctx), {
      ...(limit !== undefined ? { limit } : {}),
      ...(this.type ? { type: this.type } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>);
  }
}

/** `telescope:pulse:show`: the Pulse health rollup. */
export class TelescopePulseShow extends WindowCommand {
  static override commandName = 'telescope:pulse:show';
  static override description =
    'Pulse health: throughput, latency, slowest requests/queries, hotspots, N+1, top exceptions';

  @flags.string({ description: 'Rows per card' })
  declare top?: string;

  override async run() {
    const { apis, coreConfig } = await this.console();
    if (!coreConfig.pulse.enabled) throw new Error('Pulse is disabled (config telescope.pulse).');
    const top = intFlag(this.top, 'top');
    const windowMs = this.windowMs();
    const body = await this.handle((ctx) => apis.api.metricsPulse(ctx), {
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(top !== undefined ? { topN: top } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 10);
  }
}

/** `telescope:metrics:show`: per-type analytics (percentiles, breakdowns, throughput). */
export class TelescopeMetricsShow extends WindowCommand {
  static override commandName = 'telescope:metrics:show';
  static override description =
    'Analytics for one entry type: latency percentiles, breakdowns, throughput';

  @flags.string({ description: 'Entry type (request, query, job, cache, …)', required: true })
  declare type: string;

  @flags.string({ description: 'Time buckets' })
  declare buckets?: string;

  override async run() {
    const { apis } = await this.console();
    const windowMs = this.windowMs();
    const buckets = intFlag(this.buckets, 'buckets');
    const body = await this.handle((ctx) => apis.api.metricsStats(ctx), {
      type: this.type,
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(buckets !== undefined ? { buckets } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 10);
  }
}

/** `telescope:metrics:timeseries`: throughput over time. */
export class TelescopeMetricsTimeseries extends WindowCommand {
  static override commandName = 'telescope:metrics:timeseries';
  static override description = 'Throughput over time (total and per type, per bucket)';

  @flags.string({ description: 'Only this entry type' })
  declare type?: string;

  @flags.string({ description: 'Time buckets' })
  declare buckets?: string;

  override async run() {
    const { apis } = await this.console();
    const windowMs = this.windowMs();
    const buckets = intFlag(this.buckets, 'buckets');
    const body = await this.handle((ctx) => apis.api.metricsTimeseries(ctx), {
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(buckets !== undefined ? { buckets } : {}),
      ...(this.type ? { type: this.type } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 100);
  }
}

/** `telescope:screens:list`: per-route traffic (page visits vs API calls). */
export class TelescopeScreensList extends WindowCommand {
  static override commandName = 'telescope:screens:list';
  static override description = 'Per-route traffic: page visits, API calls or assets';

  @flags.string({ description: 'page, api or asset' })
  declare kind?: string;

  @flags.string({ description: 'Most routes (default 50, max 200)' })
  declare limit?: string;

  override async run() {
    const { apis } = await this.console();
    const windowMs = this.windowMs();
    const limit = intFlag(this.limit, 'limit');
    const body = await this.handle((ctx) => apis.api.metricsScreens(ctx), {
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(this.kind ? { kind: this.kind } : {}),
    });
    if (this.json) return this.printJson(body);
    const rows = body.data as Array<Record<string, unknown>>;
    this.table(
      rows,
      Object.keys(rows[0] ?? {}).filter((k) => typeof rows[0]?.[k] !== 'object'),
    );
  }
}

/** `telescope:ai:show`: AI spend, agent runs and unpriced calls. */
export class TelescopeAiShow extends WindowCommand {
  static override commandName = 'telescope:ai:show';
  static override description = 'AI spend (by feature, model, actor), agent runs, unpriced calls';

  @flags.string({ description: 'Rows per top list (max 50)' })
  declare top?: string;

  @flags.string({ description: 'Most agent runs (max 200)' })
  declare runs?: string;

  override async run() {
    const { apis } = await this.console();
    const windowMs = this.windowMs();
    const top = intFlag(this.top, 'top');
    const runs = intFlag(this.runs, 'runs');
    const body = await this.handle((ctx) => apis.api.metricsAi(ctx), {
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(top !== undefined ? { top } : {}),
      ...(runs !== undefined ? { runs } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 10);
  }
}

/** `telescope:exceptions:list`: the console's Exceptions screen (families over a window). */
export class TelescopeExceptionsList extends WindowCommand {
  static override commandName = 'telescope:exceptions:list';
  static override description = 'Exception families over a window, most frequent first';

  @flags.string({ description: 'Most families (max 200)' })
  declare top?: string;

  override async run() {
    const { apis } = await this.console();
    const windowMs = this.windowMs();
    const top = intFlag(this.top, 'top');
    const body = await this.handle((ctx) => apis.api.metricsStats(ctx), {
      type: 'exception',
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(top !== undefined ? { topExceptions: top } : {}),
    });
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>, 50);
  }
}

/** `telescope:exceptions:diagnose`: AI diagnosis of one exception entry. */
export class TelescopeExceptionsDiagnose extends TelescopeCommand {
  static override commandName = 'telescope:exceptions:diagnose';
  static override description =
    'AI diagnosis of an exception entry (probable cause, where to look, a fix). Spends AI tokens';

  @args.string({ description: 'Exception entry id' })
  declare id: string;

  @flags.boolean({ description: 'Skip the cached diagnosis and ask again' })
  declare fresh?: boolean;

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) =>
      apis.diagnosisApi.diagnose(ctx, this.id, this.fresh === true),
    );
    if (this.json) return this.printJson(body);
    const data = body.data as { markdown: string; cached: boolean };
    if (data.cached) this.logger.info('cached diagnosis (--fresh asks again)');
    this.logger.log(data.markdown);
  }
}

/** `telescope:retention:show`: the configured retention and sampling. */
export class TelescopeRetentionShow extends TelescopeCommand {
  static override commandName = 'telescope:retention:show';
  static override description = 'Retention (prune cutoff, keep-last, interval) and sampled types';

  override async run() {
    const { apis } = await this.console();
    const body = await this.handle((ctx) => apis.api.retention(ctx));
    if (this.json) return this.printJson(body);
    this.renderObject(body.data as Record<string, unknown>);
  }
}
