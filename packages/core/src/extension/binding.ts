import type { TelescopeExtension } from './types.js';

/**
 * The container key libraries push their telescope extension into, so their pages show up with no
 * `config/telescope.ts` change. The value is a plain `TelescopeExtension[]`, created by whoever
 * registers first (telescope or the library), in `register()`.
 */
export const TELESCOPE_EXTENSIONS_BINDING = 'agora.telescope.extensions';

/** The slice of the AdonisJS container this module touches (structural). */
export interface ExtensionsContainerLike {
  hasBinding(key: string): boolean;
  bindValue(key: string, value: unknown): void;
  make(key: string): Promise<unknown>;
}

/**
 * Bind an empty `TelescopeExtension[]` at {@link TELESCOPE_EXTENSIONS_BINDING} unless something
 * already did. Call it from a provider's `register()`. Never throws.
 */
export function ensureTelescopeExtensionsBinding(container: ExtensionsContainerLike): void {
  try {
    if (!container.hasBinding(TELESCOPE_EXTENSIONS_BINDING)) {
      container.bindValue(TELESCOPE_EXTENSIONS_BINDING, [] as TelescopeExtension[]);
    }
  } catch {
    // A container without bindValue (a test double) simply has no binding.
  }
}

/** The extensions pushed into the binding, or `[]` when it is absent or not an array. */
export async function readBoundExtensions(
  container: ExtensionsContainerLike,
): Promise<TelescopeExtension[]> {
  try {
    if (!container.hasBinding(TELESCOPE_EXTENSIONS_BINDING)) return [];
    const value = await container.make(TELESCOPE_EXTENSIONS_BINDING);
    if (!Array.isArray(value)) return [];
    return value.filter(isExtension);
  } catch {
    return [];
  }
}

/**
 * The extensions telescope runs: every configured one, then every bound one whose `name` is not
 * configured. A bound extension with the same `name` as a configured one is skipped (the config
 * wins) and reported through `onDuplicate`, once per name. Two bound extensions with the same name
 * keep the first.
 */
export function mergeExtensions(
  configured: readonly TelescopeExtension[],
  bound: readonly TelescopeExtension[],
  onDuplicate: (name: string) => void = () => {},
): TelescopeExtension[] {
  const out = [...configured];
  const names = new Set(configured.map((ext) => ext.name));
  const reported = new Set<string>();
  for (const ext of bound) {
    if (names.has(ext.name)) {
      if (!reported.has(ext.name)) {
        reported.add(ext.name);
        onDuplicate(ext.name);
      }
      continue;
    }
    names.add(ext.name);
    out.push(ext);
  }
  return out;
}

function isExtension(value: unknown): value is TelescopeExtension {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    (value as { name: string }).name !== ''
  );
}
