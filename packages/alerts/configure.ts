import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope-alerts` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. publishes `config/telescope_alerts.ts` from a stub.
 *
 * The provider reads the published config on boot, resolves the telescope runtime
 * store, and starts an exception poller → alerter → channels. No middleware needed.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope-alerts/telescope_alerts_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/telescope_alerts.stub', {});
}
