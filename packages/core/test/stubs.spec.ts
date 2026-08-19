import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the SHIPPED stubs. `node ace add @adonis-agora/telescope` writes each of
 * these files verbatim into the host app, so an empty stub silently hands the user
 * an empty `config/telescope.ts` — a defect no type-check or unit test would catch,
 * because the stub is data, not code. These assertions run over both the source
 * tree and (when present) the built `dist/` copy the tarball actually publishes.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every `.stub` file under `root`, recursively. Empty array when `root` is absent. */
function findStubs(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      found.push(...findStubs(path));
    } else if (entry.endsWith('.stub')) {
      found.push(path);
    }
  }
  return found;
}

/** The stubs `configure.ts` publishes, relative to the stubs root. */
const PUBLISHED_STUBS = [
  'config/telescope.stub',
  'config/telescope_watchers.stub',
  'config/telescope_ui.stub',
  'config/telescope_ai.stub',
  'config/telescope_alerts.stub',
  'config/telescope_mcp.stub',
  'config/telescope_cpu_profiling.stub',
  'database/migrations/create_telescope_entries_table.stub',
];

describe('shipped stubs', () => {
  const sourceStubs = findStubs(join(packageRoot, 'stubs'));

  it('finds every stub configure.ts publishes', () => {
    const relative = sourceStubs.map((path) =>
      path.slice(join(packageRoot, 'stubs').length + 1).split('\\').join('/'),
    );
    for (const expected of PUBLISHED_STUBS) {
      expect(relative).toContain(expected);
    }
  });

  it.each(sourceStubs)('%s is not empty', (path) => {
    const contents = readFileSync(path, 'utf8');
    expect(contents.trim().length).toBeGreaterThan(0);
  });

  it.each(sourceStubs)('%s has a stub exports header', (path) => {
    const contents = readFileSync(path, 'utf8');
    expect(contents.startsWith('{{{')).toBe(true);
    expect(contents).toMatch(/exports\(\{\s*to:/);
  });

  it.each(sourceStubs)('%s carries no backtick in its body', (path) => {
    // Everything after the `{{{ … }}}` header is compiled into a JS template
    // literal, so a raw backtick there terminates it and breaks `node ace add` —
    // the very defect that emptied all seven config stubs. Quote with ' instead.
    // Inside the header, backticks are ordinary JS and are fine.
    const contents = readFileSync(path, 'utf8');
    const body = contents.slice(contents.indexOf('}}}') + 3);
    expect(body).not.toContain('`');
  });

  // The tarball ships `dist/stubs`, not `stubs` — a build step that drops or
  // truncates a stub is exactly the failure this suite exists to catch. Skipped
  // before the first build, enforced after one.
  const distStubs = findStubs(join(packageRoot, 'dist', 'stubs'));

  it.runIf(distStubs.length > 0).each(distStubs)('built %s is not empty', (path) => {
    expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it.runIf(distStubs.length > 0)('built stubs mirror the source stubs', () => {
    const stubsRoot = join(packageRoot, 'stubs');
    const distRoot = join(packageRoot, 'dist', 'stubs');
    const relative = (root: string) => (path: string) =>
      path.slice(root.length + 1).split('\\').join('/');
    expect(distStubs.map(relative(distRoot)).sort()).toEqual(
      sourceStubs.map(relative(stubsRoot)).sort(),
    );
  });
});
