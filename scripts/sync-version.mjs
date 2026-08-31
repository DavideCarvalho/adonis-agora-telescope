#!/usr/bin/env node
/**
 * Rewrites every `export const VERSION = '...'` literal under each package's
 * `src/` so it matches that package's `version` in package.json — not just the
 * top-level `src/index.ts` but every sub-entry barrel too (e.g.
 * `src/watchers/index.ts`, `src/ai/index.ts`).
 *
 * Why: packages are built with plain `tsc` (no version injection), so each
 * exported VERSION is whatever is hard-coded in source. `changeset version`
 * bumps package.json but leaves the source literals stale, shipping a wrong
 * VERSION in dist. This script is chained after `changeset version` to keep
 * every literal in lockstep with the release bump. It is idempotent and only
 * touches packages that actually declare a VERSION const somewhere in `src/`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

// Matches: export const VERSION = '...' | "..." (keeps quote style + trailing `;`)
const VERSION_RE = /(export const VERSION\s*=\s*)(['"])(.*?)\2/;

/** Every `.ts` file under `dir`, recursively (skips `node_modules`/`dist`). */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const check = process.argv.includes('--check');

let changed = 0;
let checked = 0;
const mismatches = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(packagesDir, entry.name);
  const pkgJsonPath = join(pkgDir, 'package.json');
  const srcDir = join(pkgDir, 'src');
  if (!existsSync(pkgJsonPath) || !existsSync(srcDir)) continue;

  const { name, version } = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

  for (const filePath of tsFiles(srcDir)) {
    const source = readFileSync(filePath, 'utf8');
    const match = source.match(VERSION_RE);
    if (!match) continue; // file does not export a VERSION const — skip

    checked++;
    const current = match[3];
    if (current === version) continue;

    const where = `${name} (${filePath.slice(pkgDir.length + 1)})`;
    if (check) {
      mismatches.push(`  ${where}: VERSION='${current}' but package.json is '${version}'`);
      continue;
    }

    const next = source.replace(VERSION_RE, `$1$2${version}$2`);
    writeFileSync(filePath, next);
    changed++;
    console.log(`synced VERSION for ${where}: ${current} -> ${version}`);
  }
}

if (check && mismatches.length > 0) {
  console.error(
    `Exported VERSION const out of sync in ${mismatches.length} package(s):\n${mismatches.join(
      '\n',
    )}\nRun \`node scripts/sync-version.mjs\` and commit.`,
  );
  process.exit(1);
}

if (changed === 0) {
  console.log(`VERSION const in sync across ${checked} literal(s).`);
}
