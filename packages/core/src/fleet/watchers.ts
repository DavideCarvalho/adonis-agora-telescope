import type { InstanceRecord } from './derive.js';

/** Inputs of {@link fleetWatchers}. */
export interface FleetWatchersInput {
  /** The instances of the apps in view (already narrowed to the selected apps). */
  instances: readonly Pick<InstanceRecord, 'app' | 'lastSeenAt' | 'watchers'>[];
  /** Instances last seen before this (epoch ms) are left out: their entries are pruned by now. */
  since: number;
  /**
   * Watchers known to run besides the instances (this process's, when every app is in view), or
   * `null` when none are known that way.
   */
  own: readonly string[] | null;
}

/**
 * The watchers that recorded the entries in view, on a server that collects several apps: the
 * union of what each app's instances report.
 *
 * `null` (unknown) when an app in view has instances but none of them says which watchers it runs
 * (an older sender), or when nothing at all is known: a panel must not claim a watcher is off for
 * an app that never told. Within one app, instances that do not report are left out as soon as one
 * of its instances does (an old process still in the window after a deploy).
 */
export function fleetWatchers(input: FleetWatchersInput): string[] | null {
  const byApp = new Map<string, Set<string> | null>();
  for (const instance of input.instances) {
    if (instance.lastSeenAt < input.since) continue;
    const known = byApp.get(instance.app);
    if (instance.watchers === undefined) {
      if (!byApp.has(instance.app)) byApp.set(instance.app, null);
      continue;
    }
    const set = known ?? new Set<string>();
    for (const name of instance.watchers) set.add(name);
    byApp.set(instance.app, set);
  }
  if (byApp.size === 0 && input.own === null) return null;
  const union = new Set<string>(input.own ?? []);
  for (const names of byApp.values()) {
    if (names === null) return null;
    for (const name of names) union.add(name);
  }
  return [...union].sort();
}

/** Inputs of {@link consoleWatchers}. */
export interface ConsoleWatchersInput {
  /** Whether this process is a control plane (the entries on screen are the tenants'). */
  controlPlane: boolean;
  /** The fleet, or `null` when it is off (`fleet.enabled: false`). */
  fleet: {
    instances(apps: string[] | null): Promise<FleetWatchersInput['instances']>;
  } | null;
  /** The apps in view, or `null` for all of them. */
  apps: string[] | null;
  /** See {@link FleetWatchersInput.since}. */
  since: number;
  /** This process's own watchers. */
  own: () => readonly string[];
  /**
   * The watchers this process runs for its tenants (`durable` on a durable control plane): on for
   * every app in view, whatever its instances report.
   */
  forTenants?: () => readonly string[];
}

/**
 * What `/meta` says about the watchers. `{}` outside a control plane (the console keeps its own
 * list); on a control plane the union the instances report, or `{ watchers: null }` (unknown) when
 * the fleet is off or unreachable — never this process's own list, which says nothing about the
 * tenants whose entries are on screen.
 */
export async function consoleWatchers(
  input: ConsoleWatchersInput,
): Promise<{ watchers?: string[] | null }> {
  if (!input.controlPlane) return {};
  if (input.fleet === null) return { watchers: null };
  try {
    const watchers = fleetWatchers({
      instances: await input.fleet.instances(input.apps),
      since: input.since,
      own: input.apps === null ? input.own() : null,
    });
    // Unknown stays unknown: naming only the tenant watchers would claim the rest are off.
    const forTenants = input.forTenants?.() ?? [];
    if (watchers === null || forTenants.length === 0) return { watchers };
    return { watchers: [...new Set([...watchers, ...forTenants])].sort() };
  } catch {
    return { watchers: null };
  }
}
