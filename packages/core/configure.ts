import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. registers {@link TelescopeMiddleware} on the `server` middleware stack;
 * 3. publishes `config/telescope.ts` from a stub.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope/telescope_provider');
  });

  await codemods.registerMiddleware('server', [{ path: '@agora/telescope/telescope_middleware' }]);

  await codemods.makeUsingStub(stubsRoot, 'config/telescope.stub', {});
}
