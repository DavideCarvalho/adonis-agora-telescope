import { useEffect } from 'react';
import { MetricCard, MetricGrid } from '../agora-kit/blocks/metric-card';
import { Badge } from '../agora-kit/ui/badge';
import type {
  FleetApp,
  FleetCheckStatus,
  FleetIncident,
  FleetInstance,
  FleetInstanceStatus,
  FleetView,
} from '../client/types.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, clickable, PageHeader, Panel, SectionTitle, ShareBar } from './ui.js';
import { useFleet } from './use-telescope.js';

/** How often the page re-reads the fleet (the default heartbeat interval; a poll cadence, not a claim about the server's config). */
const REFRESH_MS = 15_000;

/** `ms` as `3d 4h`, `12 min`, `40 s`. */
export function humanDuration(ms: number): string {
  if (ms > 0 && ms < 1000) return '<1 s';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const STATUS_VARIANT: Record<FleetInstanceStatus, 'good' | 'info' | 'warn' | 'neutral'> = {
  up: 'good',
  starting: 'info',
  draining: 'warn',
  gone: 'neutral',
};

const HEALTH_VARIANT: Record<FleetCheckStatus, 'good' | 'warn' | 'destructive' | 'neutral'> = {
  ok: 'good',
  warn: 'warn',
  down: 'destructive',
  unknown: 'neutral',
};

/** Card tint per check status: `unknown` stays neutral, like its badge. */
const INCIDENT_TONE: Record<FleetCheckStatus, string> = {
  ok: 'border-border bg-panel-2',
  warn: 'border-warn/30 bg-warn/5',
  down: 'border-bad/30 bg-bad/5',
  unknown: 'border-border bg-panel-2',
};

function shortVersion(version: string | null): string {
  if (version === null) return '—';
  return version.length > 12 ? version.slice(0, 12) : version;
}

function InstanceRow({ instance, now }: { instance: FleetInstance; now: number }) {
  const failing = instance.checks.filter((c) => c.status !== 'ok');
  return (
    <TableRow className={instance.status === 'gone' ? 'opacity-60' : undefined}>
      <TableCell className="mono text-xs text-fg" title={instance.instanceId}>
        {instance.host}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[instance.status]}>{instance.status}</Badge>
      </TableCell>
      <TableCell className="mono text-xs text-muted-foreground" title={instance.version ?? ''}>
        {shortVersion(instance.version)}
      </TableCell>
      <TableCell className="tnum text-xs text-muted-foreground">
        {humanDuration(instance.uptimeMs)}
      </TableCell>
      <TableCell className="tnum text-xs text-muted-foreground">
        {humanDuration(now - instance.lastSeenAt)} ago
      </TableCell>
      <TableCell>
        <Badge
          variant={HEALTH_VARIANT[instance.health]}
          title={failing.map((c) => `${c.name}: ${c.status}`).join(', ') || undefined}
        >
          {instance.health === 'ok' && instance.checks.length === 0 ? 'no checks' : instance.health}
        </Badge>
      </TableCell>
      <TableCell className="tnum text-xs text-muted-foreground">
        {instance.shipping === null
          ? '—'
          : `${instance.shipping.buffered}${instance.shipping.dropped > 0 ? ` · ${instance.shipping.dropped} dropped` : ''}`}
      </TableCell>
    </TableRow>
  );
}

function IncidentCard({
  incident,
  now,
  onOpenEntry,
}: {
  incident: FleetIncident;
  now: number;
  onOpenEntry: (id: string) => void;
}) {
  const label = incident.name.charAt(0).toUpperCase() + incident.name.slice(1);
  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${INCIDENT_TONE[incident.status]}`}
      data-testid="fleet-incident"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge variant={HEALTH_VARIANT[incident.status]}>{incident.status}</Badge>
        <span className="font-medium text-fg">
          {label}: {incident.status} for {humanDuration(now - incident.since)}
        </span>
        <span className="text-xs text-muted-foreground">
          on {incident.affected} of {incident.of} instance{incident.of === 1 ? '' : 's'}
          {incident.critical ? '' : ' · not critical'}
        </span>
      </div>
      {incident.message !== null && (
        <p className="mono mt-1 text-xs text-muted-foreground">{incident.message}</p>
      )}
      {incident.exceptions.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] uppercase tracking-wider text-dim">Exceptions since then</p>
          <ul className="mt-1 flex flex-col gap-1">
            {incident.exceptions.map((e) => (
              <li
                key={e.familyHash ?? e.entryId}
                className="flex cursor-pointer items-baseline gap-2 text-xs hover:underline"
                {...clickable(() => onOpenEntry(e.entryId))}
              >
                <span className="tnum text-bad">{e.count}×</span>
                <span className="font-medium text-fg">{e.class}</span>
                <span className="truncate text-muted-foreground">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DeployTimeline({ app, now }: { app: FleetApp; now: number }) {
  if (app.deploys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No deploy in the retention window
        {app.versions[0] ? ` · running ${shortVersion(app.versions[0].version)}` : ''}.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {[...app.deploys].reverse().map((deploy) => (
        <li key={`${deploy.version}:${deploy.startedAt}`} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="mono text-muted-foreground">{shortVersion(deploy.previous)}</span>
            <span className="text-dim">→</span>
            <span className="mono font-medium text-fg">{shortVersion(deploy.version)}</span>
            <span className="text-muted-foreground">
              {humanDuration(now - deploy.startedAt)} ago
            </span>
            {deploy.complete ? (
              <Badge variant="good">complete</Badge>
            ) : deploy.total === 0 ? (
              <Badge variant="neutral">no live instances</Badge>
            ) : (
              <Badge variant="info">
                {deploy.live}/{deploy.total} live
              </Badge>
            )}
          </div>
          {!deploy.complete && deploy.total > 0 && <ShareBar fraction={deploy.progress} />}
        </li>
      ))}
    </ol>
  );
}

function AppPanel({
  app,
  now,
  onOpenEntry,
}: {
  app: FleetApp;
  now: number;
  onOpenEntry: (id: string) => void;
}) {
  const { counts } = app;
  return (
    <Panel>
      <SectionTitle
        title={app.app}
        hint={app.versions.map((v) => `${shortVersion(v.version)} × ${v.instances}`).join(' · ')}
      />
      <div className="flex flex-col gap-4">
        <MetricGrid>
          <MetricCard label="Up" value={counts.up} tone={counts.up === 0 ? 'bad' : 'good'} />
          <MetricCard label="Starting" value={counts.starting} tone="info" />
          <MetricCard label="Draining" value={counts.draining} tone="warn" />
          <MetricCard
            label="Gone"
            value={counts.gone}
            caption="missed several heartbeats in a row"
            tone="default"
          />
          {app.shipping !== null && (
            <MetricCard
              label="Buffered"
              value={app.shipping.buffered}
              caption={
                app.shipping.dropped > 0
                  ? `${app.shipping.dropped} dropped · lag ${humanDuration(app.shipping.maxLagMs)}`
                  : `lag ${humanDuration(app.shipping.maxLagMs)}`
              }
              tone={app.shipping.dropped > 0 ? 'bad' : 'default'}
            />
          )}
        </MetricGrid>

        {app.restartLoops.map((loop) => (
          <div
            key={loop.host}
            className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm"
            data-testid="fleet-restart-loop"
          >
            <span className="font-medium text-bad">Restart loop</span>{' '}
            <span className="mono text-fg">{loop.host}</span>{' '}
            <span className="text-muted-foreground">
              restarted {loop.restarts} times in {humanDuration(now - loop.since)}
            </span>
          </div>
        ))}

        {app.checks.length > 0 && (
          <div className="flex flex-col gap-2">
            {app.checks.map((incident) => (
              <IncidentCard
                key={incident.name}
                incident={incident}
                now={now}
                onOpenEntry={onOpenEntry}
              />
            ))}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Uptime</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Buffer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {app.instances.map((instance) => (
                  <InstanceRow key={instance.instanceId} instance={instance} now={now} />
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wider text-dim">Deploys</p>
            <DeployTimeline app={app} now={now} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Fleet: per app, how many instances are up, starting, draining or gone, each instance (host,
 * version, uptime, last heartbeat, health, send buffer), the deploy timeline, restart loops and
 * failing health checks with the exceptions recorded since. Follows the App picker; re-read every
 * heartbeat interval.
 */
export function FleetSection({ onOpenEntry }: { onOpenEntry: (id: string) => void }) {
  const state = useFleet();
  const { reload } = state;
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Fleet"
        description="Instances per app from their heartbeats: state, versions, deploys, restart loops and health checks."
      />
      <AsyncBlock
        state={state}
        isEmpty={(view: FleetView) => view.notice === null && view.apps.length === 0}
        empty="No instance has sent a heartbeat yet. Each instance sends one on its `fleet.interval` once it boots."
      >
        {(view) =>
          view.notice !== null ? (
            <Panel>
              <p className="text-sm text-muted-foreground">{view.notice}</p>
            </Panel>
          ) : (
            <div className="flex flex-col gap-4">
              {view.apps.map((app) => (
                <AppPanel key={app.app} app={app} now={view.now} onOpenEntry={onOpenEntry} />
              ))}
            </div>
          )
        }
      </AsyncBlock>
    </div>
  );
}
