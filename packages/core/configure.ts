import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. registers {@link TelescopeMiddleware} on the `server` middleware stack;
 * 3. publishes `config/telescope.ts` from a stub;
 * 4. publishes the `lucid` store migration so switching `store: 'lucid'` only needs
 *    `node ace migration:run` (the `memory` default ignores it).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope/telescope_provider');
  });

  await codemods.registerMiddleware('server', [{ path: '@agora/telescope/telescope_middleware' }]);

  await codemods.makeUsingStub(stubsRoot, 'config/telescope.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_telescope_entries_table.stub',
    {},
  );
}
