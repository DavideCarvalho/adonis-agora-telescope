import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { resolveConfig, type TelescopeConfig } from '../src/define_config.js';
import {
  appKeyOf,
  consoleCommandKeys,
  DEFAULT_CONSOLE_PREFIX,
} from '../src/federation/console_commands.js';

/**
 * `node ace telescope:console:key`: this app's console key (token mode), the public half of a key
 * derived from `APP_KEY` and the `consoleCommands.prefix`. Set it as the console's
 * `apps.federated.<app>.commands.publicKey`. It is not a secret; the private half never leaves.
 */
export class TelescopeConsoleKey extends BaseCommand {
  static override commandName = 'telescope:console:key';
  static override description =
    "Print this app's console key, for another console's apps.federated.<app>.commands.publicKey";
  static override options: CommandOptions = { startApp: false };

  @flags.string({ description: 'The consoleCommands prefix (default: the configured one)' })
  declare prefix?: string;

  override async run(): Promise<void> {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const prefix = this.prefix ?? config.consoleCommands?.prefix ?? DEFAULT_CONSOLE_PREFIX;
    const appKey = await appKeyOf(this.app);
    if (appKey === undefined) {
      this.logger.error('No APP_KEY: token mode seals commands to a key derived from it.');
      this.exitCode = 1;
      return;
    }
    process.stdout.write(`${consoleCommandKeys(appKey, prefix).publicKey}\n`);
  }
}
