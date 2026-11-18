import type {
  ArchitectureApp,
  ArchitectureCall,
  ArchitectureGrant,
  ArchitectureView,
} from '../client/types.js';

/**
 * How a link between two apps reads:
 * - `ok`: calls in the window, covered by a grant (or grants are not known here);
 * - `ungranted`: calls with no grant for them (authkit runs here and says none);
 * - `idle`: a grant with no call in the window;
 * - `failing`: calls, more than 5% of them failed.
 */
export type LinkState = 'ok' | 'ungranted' | 'idle' | 'failing';

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  call: ArchitectureCall | null;
  grant: ArchitectureGrant | null;
  state: LinkState;
  /** Granted capabilities the target does not list in its published catalog. */
  outsideCatalog: string[];
}

export interface GraphNode {
  app: ArchitectureApp;
  x: number;
  y: number;
  /** The most connected app, drawn in the middle (the control plane, usually). */
  hub: boolean;
}

export interface Layers {
  calls: boolean;
  grants: boolean;
}

const FAILING_RATIO = 0.05;

/** The links between apps: one per (from, to), with its call stats and its grant. */
export function buildLinks(view: ArchitectureView, layers: Layers): GraphLink[] {
  const accepts = new Map(view.apps.map((a) => [a.id, a.accepts]));
  const byPair = new Map<string, GraphLink>();
  const key = (from: string, to: string) => `${from}→${to}`;
  const linkOf = (from: string, to: string): GraphLink => {
    const id = key(from, to);
    let link = byPair.get(id);
    if (!link) {
      link = { id, from, to, call: null, grant: null, state: 'ok', outsideCatalog: [] };
      byPair.set(id, link);
    }
    return link;
  };
  if (layers.calls) for (const call of view.calls) linkOf(call.from, call.to).call = call;
  if (layers.grants) for (const grant of view.grants) linkOf(grant.from, grant.to).grant = grant;
  for (const link of byPair.values()) {
    const { call, grant } = link;
    if (call && call.count > 0 && call.failed / call.count > FAILING_RATIO) link.state = 'failing';
    else if (call && !grant && layers.grants && view.sources.grants) link.state = 'ungranted';
    else if (!call && grant) link.state = 'idle';
    const catalog = accepts.get(link.to);
    if (grant && catalog) {
      link.outsideCatalog = grant.capabilities.filter(
        (cap) => !catalog.some((c) => capabilityCovers(c, cap) || capabilityCovers(cap, c)),
      );
    }
  }
  return [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The Agora capability rule: `:` segments, a last `*` covers the rest. */
export function capabilityCovers(granted: string, required: string): boolean {
  const have = granted.split(':');
  const want = required.split(':');
  for (let i = 0; i < have.length; i++) {
    const segment = have[i];
    if (segment === '*' && i === have.length - 1) return true;
    if (i >= want.length) return false;
    if (segment !== '*' && segment !== want[i]) return false;
  }
  return have.length === want.length;
}

/**
 * Where each app sits: the most connected app in the middle, the others on a circle around it
 * (alphabetical, so the picture stays put between refreshes). One or two apps sit side by side.
 */
export function layoutNodes(apps: ArchitectureApp[], links: GraphLink[]): GraphNode[] {
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
    degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
  }
  const sorted = [...apps].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length <= 2) {
    return sorted.map((app, i) => ({ app, x: i * 360, y: 0, hub: false }));
  }
  let hub = sorted[0] as ArchitectureApp;
  for (const app of sorted) if ((degree.get(app.id) ?? 0) > (degree.get(hub.id) ?? 0)) hub = app;
  const rest = sorted.filter((a) => a.id !== hub.id);
  const radius = Math.max(260, rest.length * 70);
  return [
    { app: hub, x: 0, y: 0, hub: (degree.get(hub.id) ?? 0) > 0 },
    ...rest.map((app, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / rest.length;
      return {
        app,
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
        hub: false,
      };
    }),
  ];
}
