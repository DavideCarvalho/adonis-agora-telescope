import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the Telescope observability SPA into `dist/spa`, which the thin AdonisJS provider
 * (`providers/telescope_ui_dashboard_provider.ts`) serves as static assets. `base: './'` keeps every
 * emitted asset URL relative to `index.html`, so the SPA works under ANY mount prefix the host
 * configures (`/telescope`, a custom `path`, …) without a build-time rewrite — the provider serves
 * `index.html` at a trailing-slash canonical URL so the relative `./assets/*` references resolve
 * against the mount directory.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
  },
});
