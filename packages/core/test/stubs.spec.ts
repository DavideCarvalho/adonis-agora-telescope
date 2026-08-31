import { readdirSync, readFileSync, statSync } from 'node:fs';
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
      path
        .slice(join(packageRoot, 'stubs').length + 1)
        .split('\\')
        .join('/'),
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

  it.each(sourceStubs)('%s carries no UNESCAPED backtick or ${ in its body', (path) => {
    // Everything after the `{{{ … }}}` header is compiled into a JS template literal, so a raw
    // backtick or `${` there terminates it and makes `node ace add` THROW — the defect that emptied
    // all seven config stubs. Escaping is legitimate and renders the literal character, so only
    // UNESCAPED occurrences are flagged; inside the header, both are ordinary JS and are fine.
    //
    // This is a fast, readable signal, not the real guarantee: `stub-typecheck.spec.ts` renders every
    // stub through the actual AdonisJS engine, which is style-agnostic and catches constructs this
    // pattern does not know about.
    const contents = readFileSync(path, 'utf8');
    const body = contents.slice(contents.indexOf('}}}') + 3);
    expect(
      body.match(/(?<!\\)`/),
      `unescaped backtick in ${path} — escape it as \\\` or use '`,
    ).toBe(null);
    expect(body.match(/(?<!\\)\$\{/), `unescaped \${ in ${path} — escape it as \\\${`).toBe(null);
  });

  // The tarball ships `dist/stubs`, not `stubs` — a build step that drops or
  // truncates a stub is exactly the failure this suite exists to catch. Skipped
  // before the first build, enforced after one.
  const distStubs = findStubs(join(packageRoot, 'dist', 'stubs'));

  it.runIf(distStubs.length > 0).each(distStubs)('built %s is not empty', (path) => {
    expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0);
  });

  /**
   * `dist/stubs` is what the tarball ships and what `configure` reads, and it is produced by a `cp`
   * that no compiler knows about. Set equality alone is not enough: the commit that emptied all seven
   * config stubs left the SOURCE tree looking fine while the published copy was the broken one, and a
   * de-backticking applied to `dist` only would keep both sets identical. So compare BYTES per file.
   */
  const stubsRoot = join(packageRoot, 'stubs');
  const distRoot = join(packageRoot, 'dist', 'stubs');
  const relative = (root: string) => (path: string) =>
    path
      .slice(root.length + 1)
      .split('\\')
      .join('/');

  it.runIf(distStubs.length > 0)('built stubs mirror the source stubs, file for file', () => {
    expect(distStubs.map(relative(distRoot)).sort()).toEqual(
      sourceStubs.map(relative(stubsRoot)).sort(),
    );
  });

  it.runIf(distStubs.length > 0)('built stubs are byte-identical to the source stubs', () => {
    // Byte equality is the right assertion only because `copy:stubs` is a pure `cp -R` — it applies
    // no transformation (no version substitution, no rewriting). If that ever changes, assert against
    // the expected TRANSFORM instead, or this becomes a test that fails by design.
    //
    // Compared as Buffers, not strings, so an encoding or line-ending drift (a CRLF copy on Windows)
    // is caught too, not just visibly different text.
    for (const path of sourceStubs) {
      const name = relative(stubsRoot)(path);
      const source = readFileSync(path);
      const built = readFileSync(join(distRoot, name));
      expect(
        built.equals(source),
        `dist/stubs/${name} differs from stubs/${name} (${source.length} bytes vs ${built.length}). Two different causes, two different fixes: if the build is simply stale, run \`pnpm build\`; if a fresh build still differs, the copy step is rewriting stub content, which is a bug — \`configure\` reads the dist copy, so that drift ships to users while the source still looks fine.`,
      ).toBe(true);
    }
  });
});
