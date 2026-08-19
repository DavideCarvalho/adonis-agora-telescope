import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the two fields of a published manifest that npm resolves an install against, and that
 * nothing else in this repo type-checks or exercises: `peerDependencies` ranges and `engines.node`.
 *
 * Both have already shipped broken. Neither could be caught from inside the workspace, because
 * pnpm satisfies every peer from the workspace link and downgrades a mismatch to a warning — so
 * the defect is only visible to a consumer installing the published tarball. This suite reads the
 * manifests as npm would.
 */

// `new URL` rather than `import.meta.dirname`, which only exists from Node 20.11 — these packages
// declare `engines.node: ">=20.6.0"`, and a test asserting that field must not itself need more.
const PACKAGES_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** A range is anything carrying a comparator/wildcard — `>=`, `^`, `~`, `||`, `-`, `x`, `*`. */
const RANGE = /(>=|<=|>|<|\^|~|\|\||\s-\s|x|\*)/;

function publishableManifests(): { name: string; manifest: Record<string, unknown> }[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, 'package.json'))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => ({ name: String(manifest.name), manifest }));
}

/**
 * A `^` or `~` range over a 0.x peer is a latent install failure, not a style nit.
 *
 * Under semver, caret does not cross a minor below 1.0 — `^0.8.0` means `>=0.8.0 <0.9.0`. Every
 * later minor of that peer therefore falls out of range. pnpm downgrades an unsatisfied peer to a
 * warning, so this monorepo never notices; **npm treats it as `ERESOLVE` and refuses to install**,
 * even when the peer is marked optional (an optional peer that IS present must still match).
 *
 * `@adonis-agora/telescope-ui@1.0.1` shipped `"@adonis-agora/telescope": "^0.8.0"`, which would
 * have broken every consumer the moment telescope cut 0.9.0. Its own history shows the shape of
 * the trap: 0.1.0 declared `^0.5.0`, then 0.2.0 and 0.3.0 hand-appended `|| ^0.6.0 || ^0.7.0` as
 * each minor landed — a running repair of a range that should have been written as an interval
 * once. Hence the `||` branch in this pattern: extending the list is the workaround, not the fix.
 *
 * The rule is not "no pinning" — it is "say what you mean". An explicit `>=0.7.0 <0.8.0` is
 * accepted here; a caret that silently means the same thing is not, because it was almost never
 * intended and rots on the peer's next release.
 */
const ZERO_X_CARET_OR_TILDE = /(^|\|\|\s*)[\^~]\s*0\./;

describe('peer ranges', () => {
  const peers = publishableManifests().flatMap(({ name, manifest }) =>
    Object.entries((manifest.peerDependencies as Record<string, string>) ?? {}).map(
      ([peer, range]) => ({ pkg: name, peer, range }),
    ),
  );

  it('has peers to check', () => {
    expect(peers.length).toBeGreaterThan(0);
  });

  it.each(peers)('$pkg: $peer $range does not caret/tilde a 0.x peer', ({ peer, range }) => {
    expect(
      ZERO_X_CARET_OR_TILDE.test(range),
      `"${peer}": "${range}" pins a 0.x peer with ^ or ~, which excludes every later minor and makes npm fail with ERESOLVE. Write the range you actually mean, e.g. ">=0.7.0 <1.0.0".`,
    ).toBe(false);
  });
});

describe('published package manifests', () => {
  const manifests = publishableManifests();

  it('finds every workspace package', () => {
    expect(manifests.map((entry) => entry.name).sort()).toEqual([
      '@adonis-agora/telescope',
      '@adonis-agora/telescope-ui',
    ]);
  });

  /**
   * `engines.node` must stay a RANGE, never an exact version. The repo's `renovate.json` sets
   * `rangeStrategy: "pin"` globally, and Renovate applied it to `engines` too — rewriting
   * `">=20.6.0"` into `"v26.7.0"` in both packages and the workspace root. That made every
   * consumer on any other Node emit an engine warning on install (and fail outright under
   * `engine-strict`), for a constraint the package never had. A `matchDepTypes: ["engines"],
   * enabled: false` rule prevents it; this is the backstop if that rule is ever dropped.
   */
  it.each(manifests)(
    '$name declares engines.node as a range, not an exact version',
    ({ manifest }) => {
      const node = (manifest.engines as { node?: string } | undefined)?.node;
      expect(node, 'engines.node must be declared').toBeTypeOf('string');
      expect(
        RANGE.test(node as string),
        `engines.node is "${node}" — an exact version. Use a range such as ">=20.6.0"; Renovate's global rangeStrategy:pin must not reach engines.`,
      ).toBe(true);
    },
  );
});
