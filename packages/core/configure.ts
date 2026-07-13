import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * The opt-in features of `@adonis-agora/telescope`, each shipped as a subpath of this one
 * package. `configure` always wires the core; these are offered on top.
 */
const FEATURES = [
  {
    name: 'watchers',
    message: 'Watchers — record Lucid queries, mail, cache, outbound HTTP and logs',
    provider: '@adonis-agora/telescope/watchers_provider',
    configStub: 'config/telescope_watchers.stub',
  },
  {
    name: 'ui',
    message: 'UI — web dashboard + JSON API at /telescope',
    provider: '@adonis-agora/telescope/ui_provider',
    configStub: 'config/telescope_ui.stub',
  },
  {
    name: 'ai',
    message: 'AI — Claude-powered exception diagnosis',
    provider: '@adonis-agora/telescope/ai_provider',
    configStub: 'config/telescope_ai.stub',
  },
  {
    name: 'alerts',
    message: 'Alerts — notify Slack / webhook on new exception families',
    provider: '@adonis-agora/telescope/alerts_provider',
    configStub: 'config/telescope_alerts.stub',
  },
  {
    name: 'mcp',
    message: 'MCP — expose telemetry to a coding agent over the Model Context Protocol',
    provider: '@adonis-agora/telescope/mcp_provider',
    configStub: 'config/telescope_mcp.stub',
  },
] as const;

type FeatureName = (typeof FEATURES)[number]['name'];

/**
 * `node ace configure @adonis-agora/telescope` — auto-wires the package:
 *
 * 1. registers the core service provider in `adonisrc.ts`;
 * 2. registers {@link TelescopeMiddleware} on the `server` middleware stack;
 * 3. publishes `config/telescope.ts` and the `lucid` store migration (so switching
 *    `store: 'lucid'` only needs `node ace migration:run`; the `memory` default
 *    ignores it);
 * 4. offers the optional features (watchers / ui / ai / alerts) — each is a subpath
 *    of this same package. The selected ones get their provider registered in
 *    `adonisrc.ts` (`@adonis-agora/telescope/<feature>_provider`) and their config stub
 *    published, folding in what used to be each sub-package's own `configure`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // — core —
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/telescope/telescope_provider');
  });

  await codemods.registerMiddleware('server', [
    { path: '@adonis-agora/telescope/telescope_middleware' },
  ]);

  await codemods.makeUsingStub(stubsRoot, 'config/telescope.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_telescope_entries_table.stub',
    {},
  );

  // — optional features (subpaths of this same package) —
  let selected: FeatureName[];
  try {
    selected = await command.prompt.multiple(
      'Select the optional telescope features to enable',
      FEATURES.map((feature) => ({ name: feature.name, message: feature.message })),
    );
  } catch {
    // Non-interactive runs (CI / --no-interactive) get the core only; features can be
    // enabled later by re-running configure or wiring the providers by hand.
    selected = [];
  }

  for (const feature of FEATURES) {
    if (!selected.includes(feature.name)) continue;

    await codemods.updateRcFile((rcFile) => {
      rcFile.addProvider(feature.provider);
    });
    await codemods.makeUsingStub(stubsRoot, feature.configStub, {});
  }
}
