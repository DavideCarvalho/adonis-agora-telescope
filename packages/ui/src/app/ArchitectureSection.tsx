import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { Toolbar } from '../agora-kit/blocks/page-header';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import type {
  ArchitectureApp,
  ArchitectureHealth,
  ArchitectureView,
  ArchitectureWindow,
} from '../client/types.js';
import {
  buildLinks,
  type GraphLink,
  type Layers,
  type LinkState,
  layoutNodes,
} from './architecture-graph.js';
import { AsyncBlock, PageHeader, Panel, SectionTitle } from './ui.js';
import { useArchitecture } from './use-telescope.js';

const REFRESH_MS = 30_000;
const WINDOWS = ['1h', '6h', '24h'] as const;
const LAYERS = ['all', 'calls', 'grants'] as const;

const HEALTH_VARIANT: Record<ArchitectureHealth, 'good' | 'warn' | 'destructive' | 'neutral'> = {
  ok: 'good',
  warn: 'warn',
  down: 'destructive',
  unknown: 'neutral',
};

/** Edge colour per link state (theme tokens, so light and dark both work). */
const LINK_COLOR: Record<LinkState, string> = {
  ok: 'var(--color-info)',
  ungranted: 'var(--color-warn)',
  idle: 'var(--color-fg-2)',
  failing: 'var(--color-bad)',
};

const LINK_LABEL: Record<LinkState, string> = {
  ok: 'calls',
  ungranted: 'calls without a grant',
  idle: 'granted, no call in the window',
  failing: 'failing calls',
};

type Selection = { kind: 'app'; id: string } | { kind: 'link'; id: string } | null;

type AppNodeData = { app: ArchitectureApp; hub: boolean };

function AppNode({ data, selected }: NodeProps<Node<AppNodeData>>) {
  const { app, hub } = data;
  return (
    <div
      data-app-node={app.id}
      className={`min-w-[170px] rounded-lg border bg-panel px-3 py-2 text-left shadow-sm ${
        selected ? 'border-brand ring-2 ring-brand/30' : 'border-border'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-fg-2" />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[12.5px] font-semibold text-fg">{app.id}</span>
        <Badge variant={HEALTH_VARIANT[app.health]}>{app.health}</Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-fg-2">
        {app.instances !== null && (
          <span>
            {app.instances} instance{app.instances === 1 ? '' : 's'}
          </span>
        )}
        {app.roles.length > 0 && <span>· {app.roles.join(', ')}</span>}
        {hub && <span className="text-brand">· most connected</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-fg-2" />
    </div>
  );
}

const NODE_TYPES = { app: AppNode };

function linkLabel(link: GraphLink): string {
  const parts: string[] = [];
  if (link.call) {
    parts.push(`${link.call.count} call${link.call.count === 1 ? '' : 's'}`);
    parts.push(`p95 ${link.call.p95Ms} ms`);
    if (link.call.failed > 0) parts.push(`${link.call.failed} failed`);
  }
  if (link.grant) {
    parts.push(
      `${link.grant.capabilities.length} capabilit${link.grant.capabilities.length === 1 ? 'y' : 'ies'}`,
    );
  }
  return parts.join(' · ');
}

function Notices({ view }: { view: ArchitectureView }) {
  const missing: string[] = [];
  if (!view.sources.fleet) missing.push('no fleet here: health and instances are unknown');
  if (!view.sources.grants)
    missing.push('authkit does not run in this process: permissions are not shown');
  if (view.truncated) missing.push('the window hit the scan cap: call counts are a lower bound');
  if (missing.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-fg-2"
      data-architecture-notices
    >
      {missing.map((m) => (
        <li key={m}>· {m}</li>
      ))}
    </ul>
  );
}

function Legend() {
  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-3 p-0 text-[11px] text-fg-2"
      aria-label="legend"
    >
      {(Object.keys(LINK_LABEL) as LinkState[]).map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5"
            style={{
              background: LINK_COLOR[state],
              ...(state === 'idle'
                ? { borderTop: `2px dashed ${LINK_COLOR[state]}`, background: 'none' }
                : {}),
            }}
          />
          {LINK_LABEL[state]}
        </li>
      ))}
    </ul>
  );
}

function CapabilityList({ caps, outside }: { caps: string[]; outside?: string[] }) {
  if (caps.length === 0) return <p className="m-0 text-xs text-fg-2">none (identity only)</p>;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {caps.map((cap) => (
        <li key={cap}>
          <Badge variant={outside?.includes(cap) ? 'warn' : 'outline'} className="font-mono">
            {cap}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Details({
  view,
  links,
  selection,
}: {
  view: ArchitectureView;
  links: GraphLink[];
  selection: Selection;
}) {
  if (selection === null) {
    return (
      <p className="m-0 text-xs text-fg-2">
        Click an app or a link to see its calls, permissions and what it accepts.
      </p>
    );
  }
  if (selection.kind === 'link') {
    const link = links.find((l) => l.id === selection.id);
    if (!link) return null;
    return (
      <div className="flex flex-col gap-3 text-sm" data-architecture-details="link">
        <div className="font-mono text-[12.5px] font-semibold">
          {link.from} → {link.to}
        </div>
        <Badge
          variant={
            link.state === 'failing'
              ? 'destructive'
              : link.state === 'ungranted'
                ? 'warn'
                : 'outline'
          }
        >
          {LINK_LABEL[link.state]}
        </Badge>
        {link.call && (
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-fg-2">calls</dt>
            <dd className="m-0">{link.call.count}</dd>
            <dt className="text-fg-2">failed</dt>
            <dd className="m-0">{link.call.failed}</dd>
            <dt className="text-fg-2">avg / p95</dt>
            <dd className="m-0">
              {link.call.avgMs} / {link.call.p95Ms} ms
            </dd>
            <dt className="text-fg-2">last</dt>
            <dd className="m-0">{new Date(link.call.lastAt).toLocaleString()}</dd>
          </dl>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-2">
            {view.sources.grants ? 'Granted capabilities' : 'Permissions are not known here'}
          </span>
          {link.grant ? (
            <>
              {link.grant.disabled && <Badge variant="destructive">client disabled</Badge>}
              <CapabilityList caps={link.grant.capabilities} outside={link.outsideCatalog} />
              {link.outsideCatalog.length > 0 && (
                <p className="m-0 text-xs text-warn">
                  Highlighted: not in what {link.to} published that it accepts.
                </p>
              )}
            </>
          ) : view.sources.grants ? (
            <p className="m-0 text-xs text-fg-2">no grant</p>
          ) : null}
        </div>
      </div>
    );
  }
  const app = view.apps.find((a) => a.id === selection.id);
  if (!app) return null;
  const out = links.filter((l) => l.from === app.id);
  const into = links.filter((l) => l.to === app.id);
  return (
    <div className="flex flex-col gap-3 text-sm" data-architecture-details="app">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold">{app.id}</span>
        <Badge variant={HEALTH_VARIANT[app.health]}>{app.health}</Badge>
      </div>
      <div className="text-xs text-fg-2">
        {app.instances === null ? 'not in the fleet' : `${app.instances} live instances`}
        {app.roles.length > 0 ? ` · ${app.roles.join(', ')}` : ''}
        {app.hasClient ? ' · has a service client' : ''}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-2">Accepts from other apps</span>
        {app.accepts === null ? (
          <p className="m-0 text-xs text-fg-2">never published a catalog</p>
        ) : (
          <CapabilityList caps={app.accepts} />
        )}
      </div>
      <div className="text-xs text-fg-2">
        Calls out to: {out.map((l) => l.to).join(', ') || 'none'}
        <br />
        Called by: {into.map((l) => l.from).join(', ') || 'none'}
      </div>
    </div>
  );
}

function ArchitectureGraph({ view, layers }: { view: ArchitectureView; layers: Layers }) {
  const [selection, setSelection] = useState<Selection>(null);
  const links = useMemo(() => buildLinks(view, layers), [view, layers]);
  const placed = useMemo(() => layoutNodes(view.apps, links), [view.apps, links]);

  const nodes: Node<AppNodeData>[] = placed.map((p) => ({
    id: p.app.id,
    type: 'app',
    position: { x: p.x, y: p.y },
    data: { app: p.app, hub: p.hub },
    selected: selection?.kind === 'app' && selection.id === p.app.id,
  }));
  const edges: Edge[] = links.map((link) => {
    const color = LINK_COLOR[link.state];
    const selected = selection?.kind === 'link' && selection.id === link.id;
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      label: linkLabel(link),
      animated: link.state !== 'idle' && link.call !== null,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: selected ? 3 : 1.6,
        ...(link.state === 'idle' ? { strokeDasharray: '6 4' } : {}),
      },
      labelStyle: { fill: 'var(--color-fg)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--color-panel)' },
    };
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Panel className="h-[560px] p-0">
        <div className="h-full" data-architecture-graph>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.3}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) => setSelection({ kind: 'app', id: node.id })}
            onEdgeClick={(_, edge) => setSelection({ kind: 'link', id: edge.id })}
            onPaneClick={() => setSelection(null)}
            colorMode="system"
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </Panel>
      <Panel>
        <SectionTitle title="Details" />
        <Details view={view} links={links} selection={selection} />
        {/* The same content as text, for keyboard and screen-reader users. */}
        <div className="mt-4 border-t border-border pt-3">
          <SectionTitle title="Links" />
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-architecture-links>
            {links.map((link) => (
              <li key={link.id}>
                <button
                  type="button"
                  className="w-full rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-panel-2"
                  onClick={() => setSelection({ kind: 'link', id: link.id })}
                >
                  <span style={{ color: LINK_COLOR[link.state] }}>●</span> {link.from} → {link.to}
                </button>
              </li>
            ))}
            {links.length === 0 && <li className="text-xs text-fg-2">no link in this window</li>}
          </ul>
        </div>
      </Panel>
    </div>
  );
}

export function ArchitectureSection() {
  const [window, setWindow] = useQueryState(
    'window',
    parseAsStringLiteral(WINDOWS).withDefault('1h').withOptions({ history: 'replace' }),
  );
  const [layer, setLayer] = useQueryState(
    'layers',
    parseAsStringLiteral(LAYERS).withDefault('all').withOptions({ history: 'replace' }),
  );
  const state = useArchitecture(window as ArchitectureWindow);
  const { reload } = state;
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const layers = useMemo<Layers>(
    () => ({ calls: layer !== 'grants', grants: layer !== 'calls' }),
    [layer],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Architecture"
        description="The apps and what links them: the calls between them in the window and, where authkit runs, what each may call on the others."
      />
      <Toolbar label="architecture options">
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">Window</legend>
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={window === w ? 'default' : 'outline'}
              aria-pressed={window === w}
              onClick={() => void setWindow(w)}
            >
              {w}
            </Button>
          ))}
        </fieldset>
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">Layers</legend>
          {LAYERS.map((l) => (
            <Button
              key={l}
              size="sm"
              variant={layer === l ? 'default' : 'outline'}
              aria-pressed={layer === l}
              onClick={() => void setLayer(l)}
            >
              {l === 'all' ? 'Calls + permissions' : l === 'calls' ? 'Calls' : 'Permissions'}
            </Button>
          ))}
        </fieldset>
      </Toolbar>
      <AsyncBlock
        state={state}
        isEmpty={(view: ArchitectureView) => view.apps.length === 0}
        empty="No app to draw yet: no instance in the fleet, no call between apps in the window and no grant between them."
      >
        {(view) => (
          <div className="flex flex-col gap-3">
            <Notices view={view} />
            <Legend />
            <ArchitectureGraph view={view} layers={layers} />
          </div>
        )}
      </AsyncBlock>
    </div>
  );
}
