import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope-ui` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. publishes `config/telescope_ui.ts` from a stub.
 *
 * The provider reads the published config on boot, resolves the telescope runtime
 * store, and registers the dashboard + JSON API routes under the configured prefix,
 * each behind the `authorize` guard. No middleware needed.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope-ui/telescope_ui_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/telescope_ui.stub', {});
}
