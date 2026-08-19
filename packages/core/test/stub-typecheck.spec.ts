import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template that
 * no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace configure`. The package's own typecheck compiles `src/` against the library's own types —
 * which are trivially happy with themselves, and are reached through RELATIVE imports, so it never
 * resolves the `exports` map a consumer resolves. The sibling `stubs.spec.ts` asserts each stub is
 * non-empty, carries its `exports()` header and has no backtick in its body; all three are text
 * assertions that cannot see a type error.
 *
 * The failure mode is not hypothetical. `@adonis-agora/agent` shipped a migration whose `up()` did not
 * compile in a consumer app, because its structural `rawQuery` declared `bindings?: unknown[]` — not
 * assignable in either direction to Lucid's `RawQueryBindings`, so no per-connection client satisfied
 * it. Its whole suite stayed green. And this package shipped all seven config stubs as ZERO-BYTE files
 * for three minors. `stubs.spec.ts` catches empty; this catches "exists, has content, does not
 * compile".
 *
 * Covers all eight stubs `configure` publishes, each compiled under NodeNext + strict with the package
 * resolved BY NAME — so what is checked is the shipped `dist/**\/*.d.ts` a consumer installs, not `src/`.
 */
describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  /**
   * The harness carries its own `STUBS` list, and a list is exactly the thing that rots: add a stub to
   * `configure.ts`, forget it here, and the harness keeps printing OK while the new stub is never
   * compiled. Reading both and comparing makes that impossible.
   */
  it('checks every stub in the package, with nothing silently omitted', () => {
    const onDisk: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith('.stub')) onDisk.push(`${prefix}${entry.name}`);
      }
    };
    walk(stubsRoot, '');

    const source = readFileSync(harness, 'utf8');
    const checked = [...source.matchAll(/stub: '([^']+)'/g)].map((match) => match[1] as string);

    expect(checked.sort()).toEqual(onDisk.sort());
  });

  // Resolving the package by name makes a built package a precondition: a hard failure under CI (where
  // `pnpm test` gates the publish), a convenience skip on a developer machine that has not built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated code COMPILES for a consumer; under CI a missing',
            'build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/telescope build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Lucid + Adonis declaration graph is a few seconds; 90s is a ceiling that
    // will not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
