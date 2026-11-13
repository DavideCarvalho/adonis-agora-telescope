import type { DashboardSpec } from '../client/types.js';
import { ENTRY_TYPES } from '../client/types.js';
import { typeColor, typeLabel } from './ui.js';

/**
 * Telescope's own ⌘K entries, listed above the cross-console search (the kit's `ConsoleSearch`
 * renders them as local commands): every page, every entry type (jump to the entries list filtered
 * by it) and every contributed dashboard. Matched in the browser on the label.
 */
export type CommandTarget =
  | {
      kind: 'section';
      key:
        | 'overview'
        | 'pulse'
        | 'entries'
        | 'traces'
        | 'screens'
        | 'ai'
        | 'exceptions'
        | 'exports'
        | 'profiles'
        | 'queues'
        | 'schedules';
    }
  | { kind: 'entryType'; type: string }
  | { kind: 'dashboard'; id: string };

export interface TelescopeCommand {
  id: string;
  label: string;
  group: 'Pages' | 'Entry types' | 'Dashboards';
  hint: string;
  /** An entry type's colour. */
  dot?: string;
  target: CommandTarget;
}

const PAGES: {
  key: Extract<CommandTarget, { kind: 'section' }>['key'];
  label: string;
  hint: string;
}[] = [
  { key: 'overview', label: 'Overview', hint: 'triage grid' },
  { key: 'pulse', label: 'Pulse', hint: 'health overview' },
  { key: 'exceptions', label: 'Exceptions', hint: 'grouped by class' },
  { key: 'entries', label: 'Entries', hint: 'browse + live tail' },
  { key: 'traces', label: 'Traces', hint: 'waterfall + N+1' },
  { key: 'screens', label: 'Screens', hint: 'traffic per route' },
  { key: 'ai', label: 'AI', hint: 'spend + agent runs' },
  { key: 'profiles', label: 'CPU Profiles', hint: 'flamegraphs' },
  { key: 'queues', label: 'Queue Manager', hint: 'live jobs' },
  { key: 'schedules', label: 'Live Schedules', hint: 'next-run + history' },
  { key: 'exports', label: 'Exports', hint: 'JSON / CSV' },
];

export function buildCommands(dashboards: DashboardSpec[]): TelescopeCommand[] {
  return [
    ...PAGES.map((p) => ({
      id: p.key,
      label: p.label,
      group: 'Pages' as const,
      hint: p.hint,
      target: { kind: 'section' as const, key: p.key },
    })),
    ...ENTRY_TYPES.map((type) => ({
      id: `type:${type}`,
      label: `Entries: ${typeLabel(type)}`,
      group: 'Entry types' as const,
      hint: 'jump filtered',
      dot: typeColor(type),
      target: { kind: 'entryType' as const, type },
    })),
    ...dashboards.map((d) => ({
      id: `dashboard:${d.id}`,
      label: d.label,
      group: 'Dashboards' as const,
      hint: 'dashboard',
      target: { kind: 'dashboard' as const, id: d.id },
    })),
  ];
}
