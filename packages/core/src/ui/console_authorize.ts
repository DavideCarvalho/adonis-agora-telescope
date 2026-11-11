import type { HttpContext } from '@adonisjs/core/http';
import type { UiHttpContext } from './http.js';

/**
 * What a console `authorize` returns. The access contract shared (with identical names and shapes)
 * by every `@adonis-agora` console, so one authorizer satisfies all of them:
 * - `true` / `{ allowed: true }` → allowed.
 * - `false` / `{ allowed: false }` → `403`; `reason: 'unauthenticated'` → `401`.
 * - `{ redirectTo }` → a `302` to that path for a page navigation, a `401` JSON for an API call.
 */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

/** A {@link ConsoleAuthorizer} class, constructed through the AdonisJS container. */
// biome-ignore lint/suspicious/noExplicitAny: a container-built class may take any constructor deps.
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/**
 * The console `authorize` option, in any of its three forms:
 * - an inline function `(ctx) => result`;
 * - a {@link ConsoleAuthorizer} class (built through the container, so `@inject()` works);
 * - a lazy import of a module whose default export is such a class (`() => import('#policies/x')`).
 */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** The single shape {@link resolveConsoleAuthorize} answers with. */
export type NormalizedDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** Whether `value` is a {@link ConsoleAuthorizer} class (a constructor with `authorize` on its prototype). */
export function isConsoleAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

/** Classes discovered behind a lazy import, keyed by the importer, so the import runs once. */
const lazyClasses = new WeakMap<object, ConsoleAuthorizerClass>();

/** Build `Class` through the request's container resolver and run its `authorize`. */
async function runClass(Class: ConsoleAuthorizerClass, ctx: unknown): Promise<unknown> {
  const resolver = (ctx as { containerResolver?: { make(c: unknown): unknown } }).containerResolver;
  if (resolver === undefined || typeof resolver.make !== 'function') {
    throw new Error('console authorize: the request has no container resolver to build the class');
  }
  const instance = (await resolver.make(Class)) as ConsoleAuthorizer;
  return instance.authorize(ctx as HttpContext);
}

/** Map any `authorize` result onto a {@link NormalizedDecision}. Anything unrecognised denies. */
export function normalizeConsoleDecision(result: unknown): NormalizedDecision {
  if (result === true) return { allowed: true };
  if (result !== null && typeof result === 'object') {
    const r = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
    if (typeof r.redirectTo === 'string') {
      return { allowed: false, reason: 'unauthenticated', redirectTo: r.redirectTo };
    }
    if (r.allowed === true) return { allowed: true };
    if (r.reason === 'unauthenticated') return { allowed: false, reason: 'unauthenticated' };
  }
  return { allowed: false, reason: 'forbidden' };
}

/**
 * Turn a console `authorize` option (any of the {@link ConsoleAuthorize} forms) into one
 * `(ctx) => Promise<NormalizedDecision>`. A class is built through `ctx.containerResolver`; a lazy
 * import is remembered after its first call; a thrown error is a `403` denial, never an allow.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
): (ctx: UiHttpContext | HttpContext) => Promise<NormalizedDecision> {
  return async (ctx) => {
    try {
      if (isConsoleAuthorizerClass(authorize)) {
        return normalizeConsoleDecision(await runClass(authorize, ctx));
      }
      const remembered = lazyClasses.get(authorize);
      if (remembered !== undefined) {
        return normalizeConsoleDecision(await runClass(remembered, ctx));
      }
      const result: unknown = await (authorize as (ctx: unknown) => unknown)(ctx);
      const lazy = (result as { default?: unknown } | null)?.default;
      if (
        result !== null &&
        typeof result === 'object' &&
        !('allowed' in result) &&
        isConsoleAuthorizerClass(lazy)
      ) {
        lazyClasses.set(authorize, lazy);
        return normalizeConsoleDecision(await runClass(lazy, ctx));
      }
      return normalizeConsoleDecision(result);
    } catch {
      return { allowed: false, reason: 'forbidden' };
    }
  };
}
