import { type ComponentType, lazy } from 'react';

/** sessionStorage key marking that we already reloaded once to recover from a stale chunk. */
const RELOAD_FLAG = 'telescope-chunk-reload';

/**
 * Recovers from a failed chunk import once: during a rolling deploy an open tab may still reference
 * the previous build's hashed chunk names, which the new pods no longer have (the asset route then
 * answers with the SPA shell, and the dynamic import rejects). A single reload picks up the fresh
 * `index.html` + chunk graph. The session flag stops a reload loop when the failure is genuine (e.g.
 * offline); the error is then rethrown so React surfaces it as before.
 */
function recoverFromChunkError(error: unknown): Promise<never> {
  try {
    if (window.sessionStorage.getItem(RELOAD_FLAG) === null) {
      window.sessionStorage.setItem(RELOAD_FLAG, '1');
      window.location.reload();
      // Keep the Suspense fallback up while the page reloads.
      return new Promise<never>(() => {});
    }
  } catch {
    // Storage disabled: no automatic recovery, surface the error.
  }
  return Promise.reject(error);
}

/**
 * `React.lazy` for a named export. Every section is its own chunk, so the first paint only parses the
 * shell plus the section being opened. Chunk URLs are resolved by Vite relative to the entry module
 * (`base: './'` → `new URL('./X.js', import.meta.url)`), and the entry is served from
 * `<mount>/assets/`, so lazy chunks resolve under any mount prefix.
 */
export function lazySection<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): M[K] extends ComponentType<infer P> ? ComponentType<P> : never {
  const Component = lazy(async () => {
    const mod = await load().catch(recoverFromChunkError);
    try {
      window.sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      // ignore
    }
    return { default: mod[name] as ComponentType<unknown> };
  });
  return Component as never;
}
