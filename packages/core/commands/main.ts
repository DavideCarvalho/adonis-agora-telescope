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
  TelescopeTenantsList,
  TelescopeMetaShow,
  TelescopeExtData,
  TelescopeExtAction,
];

/**
 * The commands barrel for `@adonis-agora/telescope`: `agora:doctor`, `telescope:doctor` and the
 * `telescope:<noun>:<verb>` console commands. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/telescope/commands')`, which this package's `configure` does.
 */
const loader = new ListLoader([AgoraDoctor, TelescopeDoctor, ...consoleCommands]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);
