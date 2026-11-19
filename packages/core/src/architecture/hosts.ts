/**
 * The hosts other apps reach this control plane at, learned from the `Host` header of their
 * ingest, whoami and discovery requests: an internal service name (`http://hub-internal:3333`)
 * is how they call it, while its fleet URL is the public one. The Architecture page maps calls to
 * these hosts to this app.
 */
const MAX_HOSTS = 16;
const hosts = new Set<string>();

/** Remember `host` (a `Host` header value; the port is dropped). */
export function rememberControlPlaneHost(host: string | null | undefined): void {
  if (typeof host !== 'string') return;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '');
  if (name === '' || name.length > 253 || !/^[a-z0-9.-]+$/.test(name) || hosts.has(name)) return;
  if (hosts.size >= MAX_HOSTS) return;
  hosts.add(name);
}

/** The hosts learned so far. */
export function controlPlaneHosts(): string[] {
  return [...hosts];
}

/** Forget them (tests). */
export function __resetControlPlaneHosts(): void {
  hosts.clear();
}
