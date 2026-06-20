import type {
  DashboardSpec,
  DataProvider,
  ExtensionContext,
  ExtensionEntryType,
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

  constructor(extensions: readonly TelescopeExtension[], ctx: ExtensionContext) {
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
}
