import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import TelescopeDoctor from './telescope_doctor.js';
import {
  TelescopeEntriesClear,
  TelescopeEntriesExport,
  TelescopeEntriesList,
  TelescopeEntriesPrune,
  TelescopeEntriesShow,
} from './telescope_entries.js';
import { TelescopeFleetList } from './telescope_fleet.js';
import {
  TelescopeAiShow,
  TelescopeExceptionsDiagnose,
  TelescopeExceptionsList,
  TelescopeMetricsShow,
  TelescopeMetricsTimeseries,
  TelescopeOverviewShow,
  TelescopePulseShow,
  TelescopeRetentionShow,
  TelescopeScreensList,
  TelescopeTracesList,
  TelescopeTracesNPlusOne,
  TelescopeTracesShow,
  TelescopeTracesWaterfall,
} from './telescope_metrics.js';
import {
  TelescopeAppsList,
  TelescopeExtAction,
  TelescopeExtData,
  TelescopeJobsEnqueue,
  TelescopeJobsRetry,
  TelescopeJobsShow,
  TelescopeMetaShow,
  TelescopeProfilesList,
  TelescopeProfilesShow,
  TelescopeProfilesStatus,
  TelescopeQueuesList,
  TelescopeRequestsReplay,
  TelescopeSchedulesList,
  TelescopeTenantsList,
} from './telescope_ops.js';
import { TelescopeServerStatus } from './telescope_server.js';

/** Every `telescope:*` command that mirrors the console. Exported for tests. */
export const consoleCommands = [
  TelescopeEntriesList,
  TelescopeEntriesShow,
  TelescopeEntriesExport,
  TelescopeEntriesPrune,
  TelescopeEntriesClear,
  TelescopeTracesList,
  TelescopeTracesShow,
  TelescopeTracesWaterfall,
  TelescopeTracesNPlusOne,
  TelescopeOverviewShow,
  TelescopePulseShow,
  TelescopeMetricsShow,
  TelescopeMetricsTimeseries,
  TelescopeScreensList,
  TelescopeAiShow,
  TelescopeExceptionsList,
  TelescopeExceptionsDiagnose,
  TelescopeRetentionShow,
  TelescopeRequestsReplay,
  TelescopeSchedulesList,
  TelescopeQueuesList,
  TelescopeJobsShow,
  TelescopeJobsRetry,
  TelescopeJobsEnqueue,
  TelescopeProfilesStatus,
  TelescopeProfilesList,
  TelescopeProfilesShow,
  TelescopeAppsList,
  TelescopeTenantsList,
  TelescopeMetaShow,
  TelescopeExtData,
  TelescopeExtAction,
  TelescopeFleetList,
];

/**
 * The commands barrel for `@adonis-agora/telescope`: `agora:doctor`, `telescope:doctor`,
 * `telescope:server:status` and the
 * `telescope:<noun>:<verb>` console commands. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/telescope/commands')`, which this package's `configure` does.
 */
const loader = new ListLoader([
  AgoraDoctor,
  TelescopeDoctor,
  TelescopeServerStatus,
  ...consoleCommands,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);
