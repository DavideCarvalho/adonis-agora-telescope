import type {
  ArchitectureApp,
  ArchitectureCall,
  ArchitectureGrant,
  ArchitectureInfra,
  ArchitectureUse,
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
  infra: boolean;
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

export const APP_WIDTH = 230;
export const INFRA_WIDTH = 200;
const APP_GAP = 80;
const INFRA_GAP = 20;
const ROW_GAP = 200;

export interface PlacedApp {
  kind: 'app';
  app: ArchitectureApp;
  x: number;
  y: number;
  /** The most connected app: the middle of the row. */
  hub: boolean;
}

export interface PlacedInfra {
  kind: 'infra';
  infra: ArchitectureInfra;
  x: number;
  y: number;
  /** The apps using it. */
  usedBy: string[];
}

/**
 * The picture: apps in one row, the most connected in the middle and the others alternating
 * around it by how connected they are; the backends in a row below, each under the apps that use
 * it (the mean of their positions), pushed apart so none overlap. Same input, same picture.
 */
export function layoutGraph(
  apps: ArchitectureApp[],
  links: GraphLink[],
  infra: ArchitectureInfra[],
  uses: ArchitectureUse[],
): Array<PlacedApp | PlacedInfra> {
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const link of links) {
    bump(link.from);
    bump(link.to);
  }
  for (const use of uses) bump(use.app);
  const byDegree = [...apps].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );
  // Most connected in the middle, then right, left, right…
  const row: ArchitectureApp[] = [];
  byDegree.forEach((app, i) => {
    if (i % 2 === 0) row.push(app);
    else row.unshift(app);
  });
  const step = APP_WIDTH + APP_GAP;
  const offset = ((row.length - 1) * step) / 2;
  const placedApps: PlacedApp[] = row.map((app, i) => ({
    kind: 'app',
    app,
    x: Math.round(i * step - offset),
    y: 0,
    hub: app.id === byDegree[0]?.id && (degree.get(app.id) ?? 0) > 1 && row.length > 1,
  }));
  const appX = new Map(placedApps.map((p) => [p.app.id, p.x + APP_WIDTH / 2]));

  const usedBy = new Map<string, string[]>();
  for (const use of uses) {
    const list = usedBy.get(use.infra) ?? [];
    if (!list.includes(use.app)) list.push(use.app);
    usedBy.set(use.infra, list);
  }
  const wanted = infra
    .map((item) => {
      const users = (usedBy.get(item.id) ?? []).filter((id) => appX.has(id)).sort();
      const xs = users.map((id) => appX.get(id) as number);
      const center = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
      return { item, users, center };
    })
    .sort((a, b) => a.center - b.center || a.item.id.localeCompare(b.item.id));
  // Keep the order, push right on overlap, then centre the row under its wanted centre.
  const xs: number[] = [];
  const minStep = INFRA_WIDTH + INFRA_GAP;
  for (const [i, w] of wanted.entries()) {
    const left = w.center - INFRA_WIDTH / 2;
    xs.push(i === 0 ? left : Math.max(left, (xs[i - 1] as number) + minStep));
  }
  if (wanted.length > 0) {
    const shift =
      wanted.reduce((acc, w, i) => acc + (w.center - INFRA_WIDTH / 2 - (xs[i] as number)), 0) /
      wanted.length;
    for (let i = 0; i < xs.length; i++) xs[i] = (xs[i] as number) + shift;
  }
  const placedInfra: PlacedInfra[] = wanted.map((w, i) => ({
    kind: 'infra',
    infra: w.item,
    x: Math.round(xs[i] as number),
    y: ROW_GAP,
    usedBy: w.users,
  }));
  return [...placedApps, ...placedInfra];
}

/** `1 call`, `3 calls`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
