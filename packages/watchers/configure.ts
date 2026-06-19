import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope-watchers` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. publishes `config/telescope_watchers.ts` from a stub.
 *
 * The watchers record through `@agora/telescope`'s runtime store handle, so no
 * middleware registration is needed — only the provider, which subscribes the
 * enabled watchers to the application emitter on boot.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope-watchers/telescope_watchers_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/telescope_watchers.stub', {});
}
