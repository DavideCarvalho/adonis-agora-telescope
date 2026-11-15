/**
 * `propagation` in `config/telescope.ts`: carry one trace across your apps.
 *
 * ```ts
 * export default defineConfig({
 *   propagation: {
 *     targets: ['https://billing.internal', env.get('SEARCH_URL')],
 *   },
 * })
 * ```
 */
export interface PropagationConfig {
  /**
   * Where outgoing calls carry the trace (`traceparent` / `tracestate`): origins
   * (`https://billing.internal`, `http://localhost:3334`; a URL with a path is read for its origin)
   * or a `RegExp` tested against the origin. `'all'` sends them everywhere, third parties included.
   * Default `[]`: nothing is sent.
   */
  targets?: ReadonlyArray<string | RegExp> | 'all';
  /**
   * Continue the trace an incoming request carries (`traceparent`), so the caller's trace id and
   * span show on this app's entries. Default `true`. Set `false` on an app the public calls
   * directly when you do not want callers to choose its trace ids.
   */
  incoming?: boolean;
  /**
   * Also add the headers to calls made with `node:http` / `node:https` (`http.request`, axios,
   * got). `fetch` is always covered. Default `false`.
   */
  nodeHttp?: boolean;
  /**
   * Carry the trace in `@adonisjs/queue` jobs: dispatched inside a request, a job runs in that
   * request's trace. Default `true`.
   */
  queue?: boolean;
}

/** {@link PropagationConfig} with defaults applied. */
export interface ResolvedPropagationConfig {
  /** `'all'`, or the matchers (empty: nothing is sent). */
  targets: 'all' | Array<string | RegExp>;
  incoming: boolean;
  nodeHttp: boolean;
  queue: boolean;
}

/** The origin (`scheme://host[:port]`) of `value`, lowercased; `null` when it is not a URL. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Resolve `propagation`. Throws on a target that is not an http(s) origin. */
export function resolvePropagation(
  config: PropagationConfig | undefined,
): ResolvedPropagationConfig {
  const raw = config?.targets ?? [];
  let targets: ResolvedPropagationConfig['targets'];
  if (raw === 'all') {
    targets = 'all';
  } else if (Array.isArray(raw)) {
    targets = raw.map((target) => {
      if (target instanceof RegExp) return target;
      const origin = typeof target === 'string' ? originOf(target) : null;
      if (origin === null) {
        throw new Error(
          `@adonis-agora/telescope: propagation.targets: ${JSON.stringify(target)} is not an http(s) origin (e.g. "https://billing.internal")`,
        );
      }
      return origin;
    });
  } else {
    throw new Error(
      "@adonis-agora/telescope: propagation.targets must be a list of origins or 'all'",
    );
  }
  return {
    targets,
    incoming: config?.incoming ?? true,
    nodeHttp: config?.nodeHttp ?? false,
    queue: config?.queue ?? true,
  };
}

/** Whether a call to `origin` may carry the trace. */
export function isPropagationTarget(
  targets: ResolvedPropagationConfig['targets'],
  origin: string | null,
): boolean {
  if (origin === null) return false;
  if (targets === 'all') return true;
  for (const target of targets) {
    if (typeof target === 'string') {
      if (target === origin) return true;
    } else {
      target.lastIndex = 0;
      if (target.test(origin)) return true;
    }
  }
  return false;
}

/** Whether outgoing calls carry the trace at all. */
export function propagatesOutbound(config: ResolvedPropagationConfig): boolean {
  return config.targets === 'all' || config.targets.length > 0;
}
