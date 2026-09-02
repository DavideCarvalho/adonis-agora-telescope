import type {
  DashboardSpec,
  DataProvider,
  ExtensionContext,
  ExtensionEntryType,
  ScheduleContribution,
  TelescopeExtension,
} from './types.js';

/**
 * Eagerly validates and collects every contribution from the registered extensions at boot. Enforces
 * uniqueness — two extensions cannot contribute the same entry-type id, dashboard id, or provider
 * name; a collision throws at boot (fail-closed), naming both owners, so drift is a startup error
 * rather than a confusing runtime one. Accessors return copies; `findProvider` also tracks the owning
 * extension so the HTTP layer can validate the `/ext/:ext/data/:provider` namespace.
 */
export class ExtensionRegistry {
  readonly #entryTypes: ExtensionEntryType[] = [];
  readonly #dashboards: DashboardSpec[] = [];
  readonly #providers = new Map<string, DataProvider>();
  readonly #providerOwners = new Map<string, string>();
  /** Kept so the schedules hook can be awaited AFTER boot — see {@link collectSchedules}. */
  readonly #extensions: readonly TelescopeExtension[];
  readonly #ctx: ExtensionContext;

  constructor(extensions: readonly TelescopeExtension[], ctx: ExtensionContext) {
    this.#extensions = extensions;
    this.#ctx = ctx;
    const entryOwners = new Map<string, string>();
    const dashOwners = new Map<string, string>();

    for (const ext of extensions) {
      for (const et of ext.entryTypes?.(ctx) ?? []) {
        const prev = entryOwners.get(et.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope entry type "${et.id}" is contributed by both "${prev}" and "${ext.name}". Entry-type ids must be unique.`,
          );
        }
        entryOwners.set(et.id, ext.name);
        this.#entryTypes.push(et);
      }

      for (const d of ext.dashboards?.(ctx) ?? []) {
        const prev = dashOwners.get(d.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope dashboard "${d.id}" is contributed by both "${prev}" and "${ext.name}". Dashboard ids must be unique.`,
          );
        }
        dashOwners.set(d.id, ext.name);
        this.#dashboards.push(d);
      }

      for (const p of ext.dataProviders?.(ctx) ?? []) {
        const prev = this.#providerOwners.get(p.name);
        if (prev !== undefined) {
          throw new Error(
            `Telescope data provider "${p.name}" is contributed by both "${prev}" and "${ext.name}". Provider names must be unique.`,
          );
        }
        this.#providerOwners.set(p.name, ext.name);
        this.#providers.set(p.name, p);
      }
    }
  }

  entryTypes(): ExtensionEntryType[] {
    return [...this.#entryTypes];
  }
  dashboards(): DashboardSpec[] {
    return [...this.#dashboards];
  }
  findProvider(name: string): DataProvider | undefined {
    return this.#providers.get(name);
  }
  providerOwner(name: string): string | undefined {
    return this.#providerOwners.get(name);
  }

  /**
   * Every schedule the extensions know about.
   *
   * Async and separate from the constructor on purpose: the other hooks describe
   * static shape (nav, panels, providers) and can run while the container is still
   * booting, but a scheduler is a live service an extension has to resolve, and the
   * schedule watcher it feeds may not exist yet. This is called from the provider's
   * `ready()`, once everything is up.
   *
   * A throwing extension is skipped with a warning rather than taking the app down:
   * a dashboard list is not worth a failed boot.
   */
  async collectSchedules(): Promise<ScheduleContribution[]> {
    const out: ScheduleContribution[] = [];
    const seen = new Set<string>();
    for (const ext of this.#extensions) {
      if (typeof ext.schedules !== 'function') continue;
      try {
        for (const schedule of await ext.schedules(this.#ctx)) {
          if (seen.has(schedule.name)) continue;
          seen.add(schedule.name);
          out.push(schedule);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Telescope: extension "${ext.name}" failed to contribute schedules: ${message}`,
        );
      }
    }
    return out;
  }
}
