import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { resolveConfig, type TelescopeConfig } from '../src/define_config.js';
import { getTelescopeRuntime } from '../src/registry.js';
import { telescopeTopologyStatus } from '../src/topology/status.js';

/**
 * `node ace telescope:server:status`: on a tenant, whether the central server accepts its token
 * and as which app; on the control plane, the ingest route and the apps it has entries for. Exit
 * code 1 when the app is refused or the server has no telescope store.
 */
export class TelescopeServerStatus extends BaseCommand {
  static override commandName = 'telescope:server:status';
  static override description =
    'Show whether the central telescope server accepts this app, or which apps it has entries for';
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  override async run(): Promise<void> {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const status = await telescopeTopologyStatus(config.topology, getTelescopeRuntime().store);
    const failed =
      (status.topology === 'tenant' && !status.accepted) ||
      (status.topology === 'control-plane' && !status.running);
    if (failed) this.exitCode = 1;
    if (this.json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return;
    }
    if (status.topology === 'standalone') {
      this.logger.info('Standalone: this app keeps its own telescope entries.');
      return;
    }
    if (status.topology === 'tenant') {
      this.logger.info(`Server: ${status.server}`);
      this.logger.info(`App:    ${status.partition}`);
      if (status.accepted) this.logger.success(status.message);
      else this.logger.error(status.message);
      return;
    }
    this.logger.info(`Ingest: ${status.ingest}`);
    if (!status.running) {
      this.logger.error('Telescope is not running here: received entries cannot be stored.');
      return;
    }
    if (status.apps.length === 0) {
      this.logger.info('No app has sent entries yet.');
      return;
    }
    const table = this.ui.table();
    table.head(['App', 'Entries']);
    for (const row of status.apps) table.row([row.app, String(row.entries)]);
    table.render();
  }
}
