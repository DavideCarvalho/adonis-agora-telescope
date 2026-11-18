import type { ComboOption } from '../agora-kit/blocks/combo-field';
import { ENTRY_TYPES, type TelescopeMeta } from '../client/types.js';
import { typeLabel } from './ui.js';

/**
 * The watcher that records each built-in entry type, as `/meta`'s `watchers` names it. Types with
 * no entry here (exceptions, client exceptions, OTel spans) are not gated by one watcher.
 */
const WATCHER_OF_TYPE: Record<string, string> = {
  request: 'request',
  query: 'query',
  job: 'queue',
  mail: 'mail',
  cache: 'cache',
  redis: 'redis',
  event: 'events',
  log: 'logs',
  'http-client': 'http-client',
  diagnostic: 'diagnostics',
};

/**
 * The entry types a filter offers: the built-in ones, then those extensions contribute. A built-in
 * type whose watcher `/meta` says is not running gets a "watcher off" hint; when `/meta` doesn't
 * say (`watchers` absent or `null`), no type is marked.
 */
export function entryTypeOptions(meta: TelescopeMeta | null | undefined): ComboOption[] {
  const running = Array.isArray(meta?.watchers) ? new Set(meta.watchers) : null;
  const builtIn: ComboOption[] = ENTRY_TYPES.map((type) => {
    const watcher = WATCHER_OF_TYPE[type];
    const off = running !== null && watcher !== undefined && !running.has(watcher);
    return { value: type, label: typeLabel(type), ...(off ? { hint: 'watcher off' } : {}) };
  });
  const known = new Set<string>(ENTRY_TYPES);
  const contributed = (meta?.entryTypes ?? [])
    .filter((t) => !known.has(t.id))
    .map((t) => ({ value: t.id, label: t.label }));
  return [...builtIn, ...contributed];
}
