import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIGNALS = fileURLToPath(new URL('../../src/fleet/signals.ts', import.meta.url));

/**
 * Run a child process with the observer installed, send it a real SIGTERM from outside, and
 * report how it ended. The module has no imports, so Node runs it with its types stripped.
 */
function run(script: string): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIGNALS } },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('ready\n')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the child did not exit on SIGTERM: ${out}`));
    }, 10_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

const preamble = `
  const { observeShutdownSignals } = await import(process.env.SIGNALS);
  observeShutdownSignals(() => console.log('draining'));
  setInterval(() => {}, 1000);
`;

describe('shutdown signal observer (real signals)', () => {
  it('a process that does not handle SIGTERM still exits on it, after draining', async () => {
    const result = await run(`${preamble} console.log('ready');`);
    expect(result.out).toContain('draining');
    expect(result.signal).toBe('SIGTERM');
  }, 15_000);

  it('a process that handles SIGTERM keeps its own behaviour', async () => {
    const result = await run(`${preamble}
      process.once('SIGTERM', () => {
        console.log('own handler');
        process.exit(7);
      });
      console.log('ready');`);
    expect(result.out).toContain('draining');
    expect(result.out).toContain('own handler');
    expect(result.code).toBe(7);
  }, 15_000);
});
