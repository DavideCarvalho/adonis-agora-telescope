/**
 * The committed type entry for `@adonis-agora/telescope-ui` (the package's `types` point at the uncommitted
 * `dist/`). It mirrors the root export, the AdonisJS provider, so tooling that resolves the
 * package from source (TanStack Intent's skill-example typecheck) finds it; `/client` resolves
 * beside it to `src/client`. It is not built or published: the build only emits `providers/`
 * and `src/client/`.
 */
export { default } from '../providers/telescope_ui_dashboard_provider.js';
