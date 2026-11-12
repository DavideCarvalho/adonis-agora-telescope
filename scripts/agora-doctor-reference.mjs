#!/usr/bin/env node
// Fetches the agora-doctor reference copies (dist/agora-doctor/*.ts.txt) from the published
// @adonis-agora/durable (the `rc` dist-tag while the 1.0 rc runs, else `latest`) into
// .agora-doctor-reference/, for scripts/check-agora-doctor.mjs.
//
// Until a durable release ships the reference, this falls back to this repo's own copies and says
// so (the check then only proves the published copies match the sources). Pass
// --required to fail instead.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve('.agora-doctor-reference');
const local = resolve('packages/core/dist/agora-doctor');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function fallback(reason) {
  if (process.argv.includes('--required')) {
    console.error(`agora-doctor: ${reason}`);
    process.exit(1);
  }
  console.warn(`agora-doctor: ${reason}; comparing against this repo's own build instead.`);
  cpSync(local, out, { recursive: true });
}

let missing = null;
try {
  const tags = JSON.parse(
    execFileSync('npm', ['view', '@adonis-agora/durable', 'dist-tags', '--json'], {
      encoding: 'utf8',
    }),
  );
  const version = tags.rc ?? tags.latest;
  const work = mkdtempSync(join(tmpdir(), 'agora-doctor-'));
  const tarball = execFileSync(
    'npm',
    ['pack', `@adonis-agora/durable@${version}`, '--pack-destination', work, '--silent'],
    { encoding: 'utf8' },
  ).trim();
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work]);
  const dir = join(work, 'package', 'dist', 'agora-doctor');
  if (existsSync(join(dir, 'agora_doctor.ts.txt'))) {
    cpSync(dir, out, { recursive: true });
    console.log(`agora-doctor: reference from @adonis-agora/durable@${version}`);
  } else {
    missing = `@adonis-agora/durable@${version} does not ship the reference yet`;
  }
} catch (error) {
  missing = `could not fetch @adonis-agora/durable (${error instanceof Error ? error.message : error})`;
}
if (missing !== null) fallback(missing);
