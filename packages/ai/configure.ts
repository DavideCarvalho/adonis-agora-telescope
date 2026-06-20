import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/telescope-ai` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. publishes `config/telescope_ai.ts` from a stub.
 *
 * The provider reads the published config on boot, builds a Claude-backed
 * diagnoser, and binds it into the container for the dashboard / app code to use.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/telescope-ai/telescope_ai_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/telescope_ai.stub', {});
}
