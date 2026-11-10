#!/usr/bin/env node
/**
 * Package checks for every published package, run after `pnpm build`:
 *
 * - `publint` lints the manifest (exports, files, entry points) against the built output.
 * - `attw` (Are The Types Wrong) resolves every `exports` subpath the way TypeScript does.
 *   The packages are ESM-only, so the `esm-only` profile skips the CommonJS resolution modes.
 *
 * The tarball is packed with `--ignore-scripts` so `prepack` does not rebuild what the build
 * step already produced.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
const bin = (name) => join(repoRoot, 'node_modules', '.bin', name);

let failed = false;
for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const cwd = join(packagesDir, dir.name);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private === true) continue;

  console.log(`\n== ${manifest.name}`);
  const out = mkdtempSync(join(tmpdir(), 'check-package-'));
  try {
    execFileSync(bin('publint'), ['--strict'], { cwd, stdio: 'inherit' });
    execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', out], {
      cwd,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
    execFileSync(bin('attw'), [join(out, tarball), '--profile', 'esm-only'], {
      cwd,
      stdio: 'inherit',
    });
  } catch {
    failed = true;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (failed) {
  console.error('\ncheck:package failed');
  process.exit(1);
}
