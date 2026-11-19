/**
 * The page scope every console reads from its URL: which app (`?app=`) and which organization
 * (`?tenant=`). Going to another console keeps it, so the picked app follows the viewer from
 * telescope to agent to durable.
 */
export const SCOPE_PARAMS = ['app', 'tenant'] as const;

/**
 * `href` with this page's `?app=` / `?tenant=` added, when it points at this origin and does not
 * set them itself. Other origins, and an `href` that cannot be parsed, come back unchanged.
 */
export function withPageScope(
  href: string,
  location: Pick<Location, 'href' | 'search'> = window.location,
): string {
  const here = new URLSearchParams(location.search);
  if (!SCOPE_PARAMS.some((name) => here.get(name))) return href;
  let target: URL;
  let base: URL;
  try {
    base = new URL(location.href);
    target = new URL(href, base);
  } catch {
    return href;
  }
  if (target.origin !== base.origin) return href;
  let changed = false;
  for (const name of SCOPE_PARAMS) {
    const value = here.get(name);
    if (value && !target.searchParams.has(name)) {
      target.searchParams.set(name, value);
      changed = true;
    }
  }
  if (!changed) return href;
  // Keep a relative href relative: only the path, query and hash change.
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
    ? target.toString()
    : `${target.pathname}${target.search}${target.hash}`;
}
