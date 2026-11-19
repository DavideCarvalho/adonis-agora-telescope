/**
 * Reads options a config factory keeps out of sight.
 *
 * Most AdonisJS `defineConfig()` helpers return a ConfigProvider (`{ type: 'provider', resolver }`)
 * whose options live in the resolver's closure, and some builders keep them in `#private` fields.
 * Resolving them would open the connections they describe, so instead this reads the closure and
 * the private fields through an in-process `node:inspector` session: no package code runs, no
 * connection opens, nothing is constructed. The session is synchronous, closed once the stack is
 * described, and every read stops at a deadline.
 *
 * The values come back as the live objects (a config may hold credentials): callers pick the few
 * fields they need (a bucket, a connection name, a host to hash) and drop the rest.
 */

/** What a closure holds: the names of the functions that created it, and its variables. */
export interface ClosureView {
  /** Innermost first: `redis` for `stores.redis(config)`. */
  names: string[];
  vars: Record<string, unknown>;
}

export interface Introspector {
  /** The closure of `fn`, or `undefined` when it cannot be read. */
  closure(fn: unknown): ClosureView | undefined;
  /** The `#private` fields of `obj` (keys keep their `#`), or `undefined`. */
  privates(obj: unknown): Record<string, unknown> | undefined;
  dispose(): void;
}

interface RemoteObject {
  type?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params: object,
    callback: (error: Error | null, result: unknown) => void,
  ): void;
}

const SLOT = Symbol.for('@adonis-agora/telescope.introspect');
const SLOT_EXPR = 'globalThis[Symbol.for("@adonis-agora/telescope.introspect")]';
const GROUP = 'adonis-agora-telescope-stack';
const MAX_SCOPE_VARS = 50;

type Slot = { [SLOT]?: unknown };

/**
 * An introspector, or `null` where `node:inspector` is unavailable (a runtime built without it).
 * `budgetMs` bounds the time all reads together may take; past it every read answers `undefined`.
 */
export function createIntrospector(budgetMs = 100): Introspector | null {
  let session: InspectorSession;
  try {
    const inspector = process.getBuiltinModule?.('node:inspector') as
      | { Session: new () => InspectorSession }
      | undefined;
    if (inspector === undefined) return null;
    session = new inspector.Session();
    session.connect();
  } catch {
    return null;
  }
  const deadline = Date.now() + budgetMs;
  let open = true;
  const slot = globalThis as Slot;

  /** A synchronous CDP call (an in-process session answers before `post` returns). */
  function post<T>(method: string, params: object): T {
    if (!open || Date.now() > deadline) throw new Error('introspection over');
    let done = false;
    let failure: Error | null = null;
    let out: unknown;
    session.post(method, params, (error, result) => {
      done = true;
      failure = error;
      out = result;
    });
    if (!done) throw new Error('inspector session is not synchronous');
    if (failure !== null) throw failure;
    return out as T;
  }

  function remote(value: unknown): RemoteObject {
    slot[SLOT] = value;
    try {
      return post<{ result: RemoteObject }>('Runtime.evaluate', {
        expression: SLOT_EXPR,
        objectGroup: GROUP,
        silent: true,
      }).result;
    } finally {
      delete slot[SLOT];
    }
  }

  function local(object: RemoteObject | undefined): unknown {
    if (object === undefined) return undefined;
    if (object.objectId === undefined) return object.value;
    try {
      post('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () { ${SLOT_EXPR} = this; }`,
        objectGroup: GROUP,
        silent: true,
      });
      return slot[SLOT];
    } finally {
      delete slot[SLOT];
    }
  }

  function properties(objectId: string): {
    result: PropertyDescriptor[];
    internalProperties?: PropertyDescriptor[];
    privateProperties?: PropertyDescriptor[];
  } {
    return post('Runtime.getProperties', { objectId, ownProperties: true, objectGroup: GROUP });
  }

  return {
    closure(fn) {
      if (typeof fn !== 'function') return undefined;
      try {
        const id = remote(fn).objectId;
        if (id === undefined) return undefined;
        const scopes = properties(id).internalProperties?.find((p) => p.name === '[[Scopes]]');
        if (scopes?.value?.objectId === undefined) return undefined;
        const view: ClosureView = { names: [], vars: {} };
        for (const scope of properties(scopes.value.objectId).result) {
          const description = scope.value?.description ?? '';
          // Module, Script and Global scopes are the package's own top level, not its options.
          if (!description.startsWith('Closure') || scope.value?.objectId === undefined) continue;
          const name = /^Closure \((.+)\)$/.exec(description)?.[1];
          if (name !== undefined) view.names.push(name);
          for (const variable of properties(scope.value.objectId).result.slice(0, MAX_SCOPE_VARS)) {
            if (!(variable.name in view.vars)) view.vars[variable.name] = local(variable.value);
          }
        }
        return view;
      } catch {
        return undefined;
      }
    },
    privates(obj) {
      if (obj === null || typeof obj !== 'object') return undefined;
      try {
        const id = remote(obj).objectId;
        if (id === undefined) return undefined;
        const out: Record<string, unknown> = {};
        for (const field of properties(id).privateProperties ?? []) {
          out[field.name] = local(field.value);
        }
        return out;
      } catch {
        return undefined;
      }
    },
    dispose() {
      if (!open) return;
      try {
        session.post('Runtime.releaseObjectGroup', { objectGroup: GROUP }, () => {});
      } catch {
        // already gone
      }
      open = false;
      try {
        session.disconnect();
      } catch {
        // already gone
      }
    },
  };
}
