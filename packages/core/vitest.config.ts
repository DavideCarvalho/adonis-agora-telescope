import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.{spec,test}.ts'],
    pool: 'forks',
    // The Lucid storage suite spins a fresh file-based SQLite DB (with a full
    // connection pool) per test; the default 5s timeout flakes under CI load.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
