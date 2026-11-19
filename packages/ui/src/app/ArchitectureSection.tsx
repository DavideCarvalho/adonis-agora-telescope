import '@xyflow/react/dist/style.css';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useInternalNode,
} from '@xyflow/react';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { Toolbar } from '../agora-kit/blocks/page-header';
import { useTheme } from '../agora-kit/theme';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import type {
  ArchitectureApp,
  ArchitectureHealth,
  ArchitectureInfra,
  ArchitectureView,
  ArchitectureWindow,
} from '../client/types.js';
import {
  APP_WIDTH,
  buildLinks,
  type GraphLink,
  INFRA_WIDTH,
  type Layers,
  type LinkState,
  layoutGraph,
  plural,
} from './architecture-graph.js';
import { TechIcon, techStyle } from './tech-icons.js';
import { AsyncBlock, PageHeader, Panel, SectionTitle } from './ui.js';
import { useArchitecture } from './use-telescope.js';

const REFRESH_MS = 30_000;
const WINDOWS = ['1h', '6h', '24h'] as const;
const LAYER_KEYS = ['calls', 'grants', 'infra'] as const;
type LayerKey = (typeof LAYER_KEYS)[number];
const LAYER_LABEL: Record<LayerKey, string> = {
  calls: 'Calls',
  grants: 'Permissions',
  infra: 'Infrastructure',
};

const HEALTH_DOT: Record<ArchitectureHealth, string> = {
  ok: 'bg-good',
  warn: 'bg-warn',
  down: 'bg-bad',
  unknown: 'bg-fg-2/50',
};
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
  idle: 'granted, not called in the window',
  failing: 'failing calls',
};
const INFRA_COLOR = 'var(--color-border)';

type Selection =
  | { kind: 'app'; id: string }
  | { kind: 'link'; id: string }
  | { kind: 'infra'; id: string }
  | null;

// ── nodes ───────────────────────────────────────────────────────────────────

type AppNodeData = { app: ArchitectureApp; hub: boolean };
type InfraNodeData = { infra: ArchitectureInfra; usedBy: string[] };

const hidden = '!size-1 !min-w-0 !border-0 !bg-transparent';

function AppNode({ data, selected }: NodeProps<Node<AppNodeData>>) {
  const { app, hub } = data;
  return (
    <div
      data-app-node={app.id}
      style={{ width: APP_WIDTH }}
      className={`rounded-xl border bg-panel px-3.5 py-3 text-left shadow-sm transition-shadow ${
        selected ? 'border-brand shadow-md ring-2 ring-brand/25' : 'border-border hover:shadow-md'
      }`}
    >
      <Handle type="target" position={Position.Top} className={hidden} />
      <Handle type="source" position={Position.Bottom} className={hidden} />
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft font-mono text-[13px] font-semibold uppercase text-brand"
        >
          {app.id.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-semibold text-fg">{app.id}</span>
            <span
              className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[app.health]}`}
              title={`health: ${app.health}`}
            />
          </div>
          <div className="truncate text-[11px] text-fg-2">
            {app.instances === null
              ? app.mode === 'federated'
                ? 'federated'
                : 'not in the fleet'
              : plural(app.instances, 'instance', 'instances')}
            {hub ? ' · hub' : ''}
          </div>
        </div>
      </div>
      {app.roles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {app.roles.map((role) => (
            <span
              key={role}
              className="rounded-md border border-border bg-panel-2 px-1.5 py-px font-mono text-[10.5px] text-fg-2"
            >
              {role}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function InfraNode({ data, selected }: NodeProps<Node<InfraNodeData>>) {
  const { infra, usedBy } = data;
  const style = techStyle(infra.tech);
  return (
    <div
      data-infra-node={infra.id}
      style={{ width: INFRA_WIDTH }}
      className={`flex items-center gap-2.5 rounded-full border bg-panel py-2 pr-4 pl-2.5 shadow-sm ${
        selected ? 'border-brand ring-2 ring-brand/25' : 'border-border'
      }`}
    >
      <Handle type="target" position={Position.Top} className={hidden} />
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-panel-2">
        <TechIcon tech={infra.tech} size={18} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-semibold text-fg">{infra.label}</div>
        <div className="truncate text-[10.5px] text-fg-2">
          {style.name} · {plural(usedBy.length, 'app', 'apps')}
        </div>
      </div>
    </div>
  );
}

const NODE_TYPES = { app: AppNode, infra: InfraNode };

// ── edges ───────────────────────────────────────────────────────────────────

type CallEdgeData = { link: GraphLink; label: string; lift: number };

/**
 * A link between two apps in the same row: an arc above them, from the top of one to the top of
 * the other. The two directions of a pair get different heights so they never overlap.
 */
function CallEdge({
  id,
  source,
  target,
  data,
  selected,
  markerEnd,
  style,
}: EdgeProps<Edge<CallEdgeData>>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const fw = from.measured.width ?? APP_WIDTH;
  const tw = to.measured.width ?? APP_WIDTH;
  const sx =
    from.internals.positionAbsolute.x +
    fw / 2 +
    (fw / 6) * Math.sign(to.internals.positionAbsolute.x - from.internals.positionAbsolute.x);
  const tx =
    to.internals.positionAbsolute.x +
    tw / 2 -
    (tw / 6) * Math.sign(to.internals.positionAbsolute.x - from.internals.positionAbsolute.x);
  const sy = from.internals.positionAbsolute.y;
  const ty = to.internals.positionAbsolute.y;
  const distance = Math.abs(tx - sx);
  const peak = Math.min(sy, ty) - (50 + distance * 0.18) * data.lift;
  const cx = (sx + tx) / 2;
  const path = `M ${sx} ${sy} Q ${cx} ${peak * 2 - (sy + ty) / 2} ${tx} ${ty}`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd !== undefined ? { markerEnd } : {})}
        {...(style !== undefined ? { style } : {})}
        interactionWidth={18}
      />
      <EdgeLabelRenderer>
        <div
          className={`nodrag nopan pointer-events-auto absolute rounded-full border bg-panel px-2 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-fg shadow-sm ${
            selected ? 'border-brand' : 'border-border'
          }`}
          style={{ transform: `translate(-50%, -50%) translate(${cx}px, ${peak}px)` }}
        >
          <span style={{ color: LINK_COLOR[data.link.state] }}>●</span> {data.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** App → backend: a soft curve down, no label (the details panel says what uses it). */
function InfraEdge({ sourceX, sourceY, targetX, targetY, id, style }: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      {...(style !== undefined ? { style } : {})}
      interactionWidth={14}
    />
  );
}

const EDGE_TYPES = { call: CallEdge, infra: InfraEdge };

function callLabel(link: GraphLink): string {
  const parts: string[] = [];
  if (link.call) {
    parts.push(plural(link.call.count, 'call', 'calls'));
    parts.push(`p95 ${link.call.p95Ms} ms`);
    if (link.call.failed > 0) parts.push(`${link.call.failed} failed`);
  } else if (link.grant) {
    parts.push(plural(link.grant.capabilities.length, 'capability', 'capabilities'));
  }
  return parts.join(' · ');
}

// ── side panel ──────────────────────────────────────────────────────────────

function Notices({ view, layers }: { view: ArchitectureView; layers: Layers }) {
  const missing: string[] = [];
  if (!view.sources.fleet) missing.push('no fleet here: health and instances are unknown');
  if (layers.grants && !view.sources.grants)
    missing.push('authkit does not run in this process: permissions are not shown');
  if (layers.infra && view.sources.stack === false)
    missing.push('no app reported its stack yet (it comes with each heartbeat)');
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

function Legend({ layers }: { layers: Layers }) {
  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11px] text-fg-2"
      aria-label="legend"
    >
      {(Object.keys(LINK_LABEL) as LinkState[]).map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <line
              x1="1"
              y1="3"
              x2="21"
              y2="3"
              stroke={LINK_COLOR[state]}
              strokeWidth="2"
              strokeDasharray={state === 'idle' ? '4 3' : undefined}
            />
          </svg>
          {LINK_LABEL[state]}
        </li>
      ))}
      {layers.infra && (
        <li className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <line x1="1" y1="3" x2="21" y2="3" stroke="var(--color-fg-2)" strokeWidth="1.5" />
          </svg>
          uses
        </li>
      )}
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

function UseList({ items }: { items: Array<{ who: string; uses: string[] }> }) {
  if (items.length === 0) return <p className="m-0 text-xs text-fg-2">nothing</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => (
        <li key={item.who} className="flex flex-col gap-1">
          <span className="font-mono text-xs font-semibold">{item.who}</span>
          <div className="flex flex-wrap gap-1">
            {item.uses.length === 0 ? (
              <span className="text-xs text-fg-2">unspecified</span>
            ) : (
              item.uses.map((u) => (
                <Badge key={u} variant="outline">
                  {u}
                </Badge>
              ))
            )}
          </div>
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
  const uses = view.uses ?? [];
  if (selection === null) {
    return (
      <p className="m-0 text-xs text-fg-2">
        Click an app, a link or a backend to see its calls, permissions and what uses what.
      </p>
    );
  }
  if (selection.kind === 'infra') {
    const infra = (view.infra ?? []).find((i) => i.id === selection.id);
    if (!infra) return null;
    const style = techStyle(infra.tech);
    return (
      <div className="flex flex-col gap-3 text-sm" data-architecture-details="infra">
        <div className="flex items-center gap-2">
          <TechIcon tech={infra.tech} size={20} />
          <span className="font-semibold">{infra.label}</span>
        </div>
        <span className="text-xs text-fg-2">
          {style.name} · {style.kind}
        </span>
        <span className="text-xs text-fg-2">Used by</span>
        <UseList
          items={uses
            .filter((u) => u.infra === infra.id)
            .map((u) => ({ who: u.app, uses: u.uses }))}
        />
      </div>
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
  const infraById = new Map((view.infra ?? []).map((i) => [i.id, i]));
  return (
    <div className="flex flex-col gap-3 text-sm" data-architecture-details="app">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold">{app.id}</span>
        <Badge variant={HEALTH_VARIANT[app.health]}>{app.health}</Badge>
      </div>
      <div className="text-xs text-fg-2">
        {app.instances === null
          ? app.mode === 'federated'
            ? 'federated: read from its own store'
            : 'not in the fleet'
          : `${plural(app.instances, 'live instance', 'live instances')}`}
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
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-2">Runs on</span>
        <UseList
          items={uses
            .filter((u) => u.app === app.id)
            .map((u) => {
              const infra = infraById.get(u.infra);
              return {
                who: infra ? `${techStyle(infra.tech).name} · ${infra.label}` : u.infra,
                uses: u.uses,
              };
            })}
        />
      </div>
      <div className="text-xs text-fg-2">
        Calls out to: {out.map((l) => l.to).join(', ') || 'none'}
        <br />
        Called by: {into.map((l) => l.from).join(', ') || 'none'}
      </div>
    </div>
  );
}

// ── graph ───────────────────────────────────────────────────────────────────

function ArchitectureGraph({ view, layers }: { view: ArchitectureView; layers: Layers }) {
  const [selection, setSelection] = useState<Selection>(null);
  const { theme } = useTheme();
  const links = useMemo(() => buildLinks(view, layers), [view, layers]);
  const infra = layers.infra ? (view.infra ?? []) : [];
  const uses = layers.infra ? (view.uses ?? []) : [];
  const placed = useMemo(
    () => layoutGraph(view.apps, links, infra, uses),
    [view.apps, links, infra, uses],
  );

  const nodes: Node[] = placed.map((p) =>
    p.kind === 'app'
      ? {
          id: p.app.id,
          type: 'app',
          position: { x: p.x, y: p.y },
          data: { app: p.app, hub: p.hub },
          selected: selection?.kind === 'app' && selection.id === p.app.id,
        }
      : {
          id: `infra:${p.infra.id}`,
          type: 'infra',
          position: { x: p.x, y: p.y },
          data: { infra: p.infra, usedBy: p.usedBy },
          selected: selection?.kind === 'infra' && selection.id === p.infra.id,
        },
  );

  // The second direction of a pair arcs higher, so the two never overlap.
  const seenPairs = new Set<string>();
  const edges: Edge[] = [];
  for (const link of links) {
    const pair = [link.from, link.to].sort().join('↔');
    const lift = seenPairs.has(pair) ? 1.8 : 1;
    seenPairs.add(pair);
    const color = LINK_COLOR[link.state];
    const selected = selection?.kind === 'link' && selection.id === link.id;
    edges.push({
      id: link.id,
      source: link.from,
      target: link.to,
      type: 'call',
      data: { link, label: callLabel(link), lift },
      selected,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: {
        stroke: color,
        strokeWidth: selected ? 2.6 : 1.7,
        ...(link.state === 'idle' ? { strokeDasharray: '6 5' } : {}),
      },
    });
  }
  for (const use of uses) {
    edges.push({
      id: `use:${use.app}:${use.infra}`,
      source: use.app,
      target: `infra:${use.infra}`,
      type: 'infra',
      style: { stroke: INFRA_COLOR, strokeWidth: 1.4 },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="h-[440px] p-0">
        <div className="h-full" data-architecture-graph>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            // The call arcs rise above the app row: room for them on top.
            fitViewOptions={{ padding: { top: '130px', bottom: '16px', x: '32px' }, maxZoom: 1.1 }}
            minZoom={0.3}
            maxZoom={2}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) =>
              setSelection(
                node.id.startsWith('infra:')
                  ? { kind: 'infra', id: node.id.slice('infra:'.length) }
                  : { kind: 'app', id: node.id },
              )
            }
            onEdgeClick={(_, edge) => {
              if (edge.type === 'call') setSelection({ kind: 'link', id: edge.id });
              else if (edge.id.startsWith('use:')) {
                setSelection({ kind: 'infra', id: edge.target.slice('infra:'.length) });
              }
            }}
            onPaneClick={() => setSelection(null)}
            colorMode={theme}
          >
            <Background gap={24} size={1} />
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
            {infra.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2"
                  onClick={() => setSelection({ kind: 'infra', id: item.id })}
                >
                  <TechIcon tech={item.tech} size={12} /> {item.label}
                </button>
              </li>
            ))}
            {links.length === 0 && infra.length === 0 && (
              <li className="text-xs text-fg-2">no link in this window</li>
            )}
          </ul>
        </div>
      </Panel>
    </div>
  );
}

/** `calls,infra` → layers; anything else → all on. */
export function parseLayers(raw: string | null): Layers {
  if (raw === null || raw === '') return { calls: true, grants: true, infra: true };
  const on = new Set(raw.split(','));
  return { calls: on.has('calls'), grants: on.has('grants'), infra: on.has('infra') };
}

export function ArchitectureSection() {
  const [windowKey, setWindowKey] = useQueryState(
    'window',
    parseAsStringLiteral(WINDOWS).withDefault('1h').withOptions({ history: 'replace' }),
  );
  const [rawLayers, setRawLayers] = useQueryState(
    'layers',
    parseAsString.withOptions({ history: 'replace' }),
  );
  const state = useArchitecture(windowKey as ArchitectureWindow);
  const { reload } = state;
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const layers = useMemo(() => parseLayers(rawLayers), [rawLayers]);
  const toggle = (key: LayerKey) => {
    const next = { ...layers, [key]: !layers[key] };
    const on = LAYER_KEYS.filter((k) => next[k]);
    void setRawLayers(on.length === LAYER_KEYS.length ? null : on.join(','));
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Architecture"
        description="The apps, what links them and what they run on: the calls between them in the window, what each may call on the others where authkit runs, and each app's databases, Redis and storage."
      />
      <Toolbar label="architecture options">
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">Window</legend>
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={windowKey === w ? 'default' : 'outline'}
              aria-pressed={windowKey === w}
              onClick={() => void setWindowKey(w)}
            >
              {w}
            </Button>
          ))}
        </fieldset>
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">Layers</legend>
          {LAYER_KEYS.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={layers[key] ? 'default' : 'outline'}
              aria-pressed={layers[key]}
              onClick={() => toggle(key)}
            >
              {LAYER_LABEL[key]}
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
            <Notices view={view} layers={layers} />
            <Legend layers={layers} />
            <ArchitectureGraph view={view} layers={layers} />
          </div>
        )}
      </AsyncBlock>
    </div>
  );
}
