import { useMemo, useState } from 'react';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTime,
} from '../client/format.js';
import type {
  AiCoverage,
  AiRunRow,
  AiSpend,
  AiSpendRow,
  AiUnpricedRow,
  AiUsageSummary,
} from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { DataTable } from './primitives/data_table.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, clickable, Empty, Panel, SectionTitle, ShareBar, Stat } from './ui.js';
import { useAi } from './use-telescope.js';
import { WindowSelect } from './WindowSelect.js';

/** Rows per page of the runs table. */
const RUNS_PAGE_SIZE = 15;

/**
 * The three slices of a run's time. Queue is a neutral grey (waiting is not an error), model is
 * the console accent, tools a fixed blue — never the status colours, which mean good/bad here.
 */
const SEGMENTS = [
  { key: 'queueMs', label: 'Queue', color: 'var(--muted)' },
  { key: 'modelMs', label: 'Model', color: 'var(--accent)' },
  { key: 'toolsMs', label: 'Tools', color: '#38bdf8' },
] as const;

/** `$0.0123` with enough precision for sub-cent spend, `$12.34` above a dollar. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/**
 * AI spend and agent runs, from the `agora:agent:*` events the diagnostics watcher records:
 * what the window cost (and who paid, and how much of it is an estimate), where agent runs spent
 * their time (queue, model, tools, per step), and which calls carried no price at all.
 */
export function AiSection({
  onOpenTrace,
  onOpenEntry,
}: {
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
}) {
  const [windowMs, setWindowMs] = useState(86_400_000);
  const state = useAi(windowMs);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-brand">AI · spend and agent runs</h2>
        <WindowSelect value={windowMs} onChange={setWindowMs} />
      </div>
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={5}>
        {(ai) => <AiBody ai={ai} onOpenTrace={onOpenTrace} onOpenEntry={onOpenEntry} />}
      </AsyncBlock>
    </div>
  );
}

function AiBody({
  ai,
  onOpenTrace,
  onOpenEntry,
}: {
  ai: AiUsageSummary;
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
}) {
  const [selected, setSelected] = useState<AiRunRow | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {ai.truncated && (
        <p className="text-[11px] text-warn">
          This window holds more agent events than one scan reads; totals cover the newest ones.
        </p>
      )}
      <SpendPanel spend={ai.spend} coverage={ai.coverage} />
      <RunsPanel
        ai={ai}
        selected={selected}
        onSelect={(run) => setSelected((prev) => (prev?.entryId === run.entryId ? null : run))}
        onOpenTrace={onOpenTrace}
        onOpenEntry={onOpenEntry}
      />
      <UnpricedPanel rows={ai.unpriced} coverage={ai.coverage} />
    </div>
  );
}

/** Why the spend side is empty, worded for the case at hand. */
export function NoUsage({ coverage }: { coverage: AiCoverage }) {
  if (coverage.legacyAgentLib) {
    return (
      <div className="rounded-md border border-dashed border-line px-3 py-4 text-[13px] text-muted-foreground">
        <span className="text-warn">Not measured.</span> This app publishes agent events (
        {formatCount(coverage.agentEvents)} in this window) but no{' '}
        <code className="text-foreground">agent:usage.recorded</code>, so there is no spend to show
        — which is not the same as spending nothing. The event ships with{' '}
        <code className="text-foreground">@adonis-agora/agent</code> 0.93.0; upgrade it to see cost
        by feature, model and payer here.
      </div>
    );
  }
  return (
    <Empty>
      No <code>agent:usage.recorded</code> events in this window. They are published by{' '}
      <code>@adonis-agora/agent</code> 0.93.0 and later, for agent turns and for AI calls the app
      records through <code>recordUsage</code>.
    </Empty>
  );
}

function SpendPanel({ spend, coverage }: { spend: AiSpend; coverage: AiCoverage }) {
  if (coverage.usageEvents === 0) {
    return (
      <Panel>
        <SectionTitle title="Spend" />
        <NoUsage coverage={coverage} />
      </Panel>
    );
  }
  const share = (part: number) => (spend.totalUsd > 0 ? part / spend.totalUsd : 0);
  const tokens = spend.inputTokens + spend.outputTokens;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat
          label="Total cost"
          value={formatUsd(spend.totalUsd)}
          sub={`${formatCount(spend.calls)} calls`}
        />
        <Stat
          label="Platform"
          value={formatUsd(spend.platformUsd)}
          sub={`${formatPercent(share(spend.platformUsd))} of spend`}
        />
        <Stat
          label="Estimated"
          value={formatUsd(spend.estimatedUsd)}
          sub={`${formatPercent(share(spend.estimatedUsd))} priced by estimate`}
        />
        <Stat
          label="Unpriced calls"
          value={
            <span className={spend.unpricedCalls > 0 ? 'text-warn' : ''}>
              {formatCount(spend.unpricedCalls)}
            </span>
          }
          sub="no cost recorded"
        />
        <Stat
          label="Tokens"
          value={formatCount(tokens)}
          sub={`${formatCount(spend.inputTokens)} in · ${formatCount(spend.outputTokens)} out${
            spend.cacheReadTokens > 0 ? ` · ${formatCount(spend.cacheReadTokens)} cached` : ''
          }`}
        />
      </div>
      <Panel>
        <SectionTitle
          title="Spend over time"
          hint={
            <span className="flex items-center gap-3">
              <Legend color="var(--accent)" label="users" />
              <Legend color="#a1a1aa" label="platform" />
            </span>
          }
        />
        <SpendBars spend={spend} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Breakdown title="By feature" rows={spend.byFeature} total={spend.totalUsd} />
        <Breakdown title="By model" rows={spend.byModel} total={spend.totalUsd} />
        <Breakdown title="By payer (top)" rows={spend.byActor} total={spend.totalUsd} />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Stacked bars per bucket: what users' calls cost, with the platform's share on top. */
function SpendBars({ spend }: { spend: AiSpend }) {
  const width = 1180;
  const height = 96;
  const buckets = spend.buckets;
  const max = Math.max(0, ...buckets.map((b) => b.costUsd));
  if (buckets.length === 0 || max === 0) {
    return <Empty>No priced calls in this window.</Empty>;
  }
  const slot = width / buckets.length;
  const bar = Math.max(1, slot * 0.7);
  const y = (v: number) => (v / max) * (height - 4);
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  return (
    <div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="spend over time"
      >
        {buckets.map((b, i) => {
          const userUsd = Math.max(0, b.costUsd - b.platformUsd);
          const x = i * slot + (slot - bar) / 2;
          const hUser = y(userUsd);
          const hPlatform = y(b.platformUsd);
          return (
            <g key={b.start}>
              <title>{`${formatTime(b.start)} · ${formatUsd(b.costUsd)} (${formatUsd(
                b.platformUsd,
              )} platform) · ${formatCount(b.calls)} calls`}</title>
              <rect x={x} y={height - hUser} width={bar} height={hUser} fill="var(--accent)" />
              <rect
                x={x}
                y={height - hUser - hPlatform}
                width={bar}
                height={hPlatform}
                fill="#a1a1aa"
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{first ? formatTime(first.start) : ''}</span>
        <span>peak {formatUsd(max)}</span>
        <span>{last ? formatTime(last.start) : ''}</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: AiSpendRow[]; total: number }) {
  return (
    <Panel>
      <SectionTitle title={title} />
      {rows.length === 0 ? (
        <Empty>Nothing in this window.</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="mono truncate" title={row.key}>
                  {row.key}
                </span>
                <span className="tnum shrink-0">
                  {formatUsd(row.costUsd)}
                  <span className="ml-2 text-muted-foreground">{formatCount(row.calls)}×</span>
                </span>
              </div>
              <ShareBar fraction={total > 0 ? row.costUsd / total : 0} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function statusVariant(status: AiRunRow['status']): 'good' | 'bad' | 'outline' {
  if (status === 'completed') return 'good';
  if (status === 'failed') return 'bad';
  return 'outline';
}

/**
 * A run's duration split into queue / model / tools. The remainder (the loop's own work, approval
 * waits counted by the run's clock) stays as the empty track, so a bar that is mostly track says
 * the time went somewhere none of the three measured.
 */
export function TimingBar({ run, scaleMs }: { run: AiRunRow; scaleMs: number }) {
  const total = Math.max(
    run.durationMs ?? 0,
    (run.queueMs ?? 0) + (run.modelMs ?? 0) + (run.toolsMs ?? 0),
  );
  if (total === 0 || scaleMs === 0) return <span className="text-muted-foreground">—</span>;
  const measured = SEGMENTS.some((s) => run[s.key] !== null);
  const label = SEGMENTS.map((s) => `${s.label} ${formatDuration(run[s.key])}`).join(' · ');
  return (
    <div
      className="flex h-2 min-w-[120px] overflow-hidden rounded-full bg-line"
      title={measured ? label : 'No timing breakdown (agent lib < 0.93.0)'}
      role="img"
      aria-label={measured ? label : 'no timing breakdown'}
      style={{ width: `${Math.max(8, (total / scaleMs) * 100)}%` }}
    >
      {SEGMENTS.map((s) => {
        const ms = run[s.key] ?? 0;
        if (ms <= 0) return null;
        return (
          <span
            key={s.key}
            className="block h-full"
            style={{ width: `${(ms / total) * 100}%`, background: s.color }}
          />
        );
      })}
    </div>
  );
}

function RunsPanel({
  ai,
  selected,
  onSelect,
  onOpenTrace,
  onOpenEntry,
}: {
  ai: AiUsageSummary;
  selected: AiRunRow | null;
  onSelect: (run: AiRunRow) => void;
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
}) {
  const scaleMs = Math.max(0, ...ai.runs.map((r) => r.durationMs ?? 0));
  const columns = useMemo(
    () => [
      {
        id: 'at',
        header: 'When',
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="text-muted-foreground" title={row.original.at}>
            {formatRelative(row.original.at)}
          </span>
        ),
      },
      { id: 'agent', header: 'Agent', accessorFn: (r: AiRunRow) => r.agent },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <Badge variant={statusVariant(row.original.status)}>
            {row.original.status}
            {row.original.code ? ` · ${row.original.code}` : ''}
          </Badge>
        ),
      },
      {
        id: 'model',
        header: 'Model',
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="mono text-muted-foreground">{row.original.modelId ?? '—'}</span>
        ),
      },
      {
        id: 'duration',
        header: () => <span className="block text-right">Duration</span>,
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="tnum block text-right">{formatDuration(row.original.durationMs)}</span>
        ),
      },
      {
        id: 'timing',
        header: 'Queue / model / tools',
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <TimingBar run={row.original} scaleMs={scaleMs} />
        ),
      },
      {
        id: 'steps',
        header: () => <span className="block text-right">Steps</span>,
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="tnum block text-right">{formatCount(row.original.steps)}</span>
        ),
      },
      {
        id: 'tools',
        header: () => <span className="block text-right">Tool calls</span>,
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="tnum block text-right">{formatCount(row.original.toolCalls)}</span>
        ),
      },
      {
        id: 'cost',
        header: () => <span className="block text-right">Cost</span>,
        cell: ({ row }: { row: { original: AiRunRow } }) => (
          <span className="tnum block text-right">{formatUsd(row.original.costUsd)}</span>
        ),
      },
    ],
    [scaleMs],
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <SectionTitle
          title="Agent runs"
          hint={
            <span className="flex items-center gap-3">
              {SEGMENTS.map((s) => (
                <Legend key={s.key} color={s.color} label={s.label.toLowerCase()} />
              ))}
            </span>
          }
        />
        {ai.coverage.runsWithoutTimings > 0 && (
          <p className="mb-3 text-[11px] text-muted-foreground">
            {formatCount(ai.coverage.runsWithoutTimings)} of {formatCount(ai.coverage.runEvents)}{' '}
            runs carry no queue / model / tools breakdown: they were recorded by an agent lib older
            than 0.93.0.
          </p>
        )}
        {ai.runs.length === 0 ? (
          <Empty>No finished, failed or cancelled agent runs in this window.</Empty>
        ) : (
          <DataTable
            id="ai-runs"
            data={ai.runs}
            columns={columns}
            rowKey={(r) => r.entryId}
            onRowClick={onSelect}
            rowClassName={(r) =>
              r.entryId === selected?.entryId ? 'bg-brand/10' : 'hover:bg-brand/5'
            }
            clientPageSize={RUNS_PAGE_SIZE}
          />
        )}
      </Panel>
      {selected !== null && (
        <RunDetail run={selected} onOpenTrace={onOpenTrace} onOpenEntry={onOpenEntry} />
      )}
      {ai.runs.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RunList
            title="Slowest"
            runs={ai.slowest}
            value={(r) => formatDuration(r.durationMs)}
            onSelect={onSelect}
          />
          <RunList
            title="Most expensive"
            runs={ai.mostExpensive}
            value={(r) => formatUsd(r.costUsd)}
            onSelect={onSelect}
          />
        </div>
      )}
    </div>
  );
}

function RunList({
  title,
  runs,
  value,
  onSelect,
}: {
  title: string;
  runs: AiRunRow[];
  value: (run: AiRunRow) => string;
  onSelect: (run: AiRunRow) => void;
}) {
  return (
    <Panel>
      <SectionTitle title={title} />
      {runs.length === 0 ? (
        <Empty>Nothing to rank in this window.</Empty>
      ) : (
        <Table>
          <TableBody>
            {runs.map((run) => (
              <TableRow
                key={run.entryId}
                className="cursor-pointer hover:bg-brand/5"
                {...clickable(() => onSelect(run))}
              >
                <TableCell>{run.agent}</TableCell>
                <TableCell className="mono text-muted-foreground">{run.modelId ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{formatRelative(run.at)}</TableCell>
                <TableCell className="tnum text-right">{value(run)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** One run's per-step breakdown (`stepTimings`), with links to its trace and raw entry. */
export function RunDetail({
  run,
  onOpenTrace,
  onOpenEntry,
}: {
  run: AiRunRow;
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
}) {
  const stepMax = Math.max(0, ...run.stepTimings.map((s) => (s.modelMs ?? 0) + s.toolsMs));
  return (
    <Panel className="border-brand/30">
      <SectionTitle
        title={`Run ${run.runId ?? run.entryId}`}
        hint={
          <span className="flex items-center gap-2">
            {run.traceId !== null && (
              <Button variant="outline" onClick={() => onOpenTrace(run.traceId as string)}>
                Open trace waterfall
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenEntry(run.entryId)}>
              Raw event
            </Button>
          </span>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 text-xs lg:grid-cols-6">
        <Fact label="Agent" value={run.agent} />
        <Fact label="Status" value={run.status} />
        <Fact label="Duration" value={formatDuration(run.durationMs)} />
        <Fact label="First token" value={formatDuration(run.ttftMs)} />
        <Fact label="Queue" value={formatDuration(run.queueMs)} />
        <Fact
          label="Model"
          value={`${formatDuration(run.modelMs)} · ${formatCount(run.modelCalls)} calls`}
        />
        <Fact
          label="Tools"
          value={`${formatDuration(run.toolsMs)} · ${formatCount(run.toolCalls)} calls`}
        />
        <Fact
          label="Tokens"
          value={`${formatCount(run.inputTokens)} in · ${formatCount(run.outputTokens)} out`}
        />
        <Fact label="Cost" value={formatUsd(run.costUsd)} />
        <Fact label="Model id" value={run.modelId ?? '—'} />
        <Fact label="Thread" value={run.threadId ?? '—'} />
        <Fact label="At" value={formatTime(run.at)} />
      </div>
      {run.stepTimings.length === 0 ? (
        <Empty>
          This run carries no per-step breakdown (published by an agent lib older than 0.93.0).
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead className="text-right">Model</TableHead>
              <TableHead className="text-right">Tools</TableHead>
              <TableHead className="w-[40%]">Time</TableHead>
              <TableHead>Tool calls</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.stepTimings.map((step) => {
              const model = step.modelMs ?? 0;
              const span = model + step.toolsMs;
              return (
                <TableRow key={step.step}>
                  <TableCell className="tnum">#{step.step}</TableCell>
                  <TableCell className="tnum text-right">{formatDuration(step.modelMs)}</TableCell>
                  <TableCell className="tnum text-right">{formatDuration(step.toolsMs)}</TableCell>
                  <TableCell>
                    <div
                      className="flex h-2 overflow-hidden rounded-full bg-line"
                      style={{ width: `${stepMax > 0 ? Math.max(4, (span / stepMax) * 100) : 0}%` }}
                    >
                      {model > 0 && (
                        <span
                          className="block h-full"
                          style={{ width: `${(model / span) * 100}%`, background: 'var(--accent)' }}
                        />
                      )}
                      {step.toolsMs > 0 && (
                        <span
                          className="block h-full"
                          style={{
                            width: `${(step.toolsMs / span) * 100}%`,
                            background: '#38bdf8',
                          }}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {step.tools.length === 0
                      ? '—'
                      : step.tools.map((t) => `${t.toolName} ${formatDuration(t.ms)}`).join(' · ')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="mono truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

function UnpricedPanel({ rows, coverage }: { rows: AiUnpricedRow[]; coverage: AiCoverage }) {
  return (
    <Panel>
      <SectionTitle title="Unpriced calls" hint="usage rows that carried no cost" />
      {coverage.usageEvents === 0 ? (
        <NoUsage coverage={coverage} />
      ) : rows.length === 0 ? (
        <Empty>Every call in this window carried a cost.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Feature</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Tokens in / out</TableHead>
              <TableHead className="text-right">Audio</TableHead>
              <TableHead className="text-right">Characters</TableHead>
              <TableHead>Last</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.feature}\u0000${row.model}\u0000${row.provider}`}>
                <TableCell className="mono">{row.feature}</TableCell>
                <TableCell className="mono">{row.model}</TableCell>
                <TableCell>{row.provider}</TableCell>
                <TableCell className="tnum text-right text-warn">
                  {formatCount(row.calls)}
                </TableCell>
                <TableCell className="tnum text-right">
                  {formatCount(row.inputTokens)} / {formatCount(row.outputTokens)}
                </TableCell>
                <TableCell className="tnum text-right">
                  {row.audioSeconds > 0 ? formatDuration(row.audioSeconds * 1000) : '—'}
                </TableCell>
                <TableCell className="tnum text-right">
                  {row.characters > 0 ? formatCount(row.characters) : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelative(row.lastAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
