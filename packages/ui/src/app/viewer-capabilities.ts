import { type ConsoleCapabilityTable, consoleCapabilityAllows } from './console_capabilities.js';
import { useMeta } from './use-telescope.js';

/** Telescope's console capabilities, as the server's table classifies them. */
const TABLE: ConsoleCapabilityTable = {
  'telescope:console:read': 'read',
  'telescope:console:queues': 'write',
  'telescope:console:replay': 'write',
};

/**
 * Whether `granted` allows `needed`: the shared matcher (`console_capabilities.ts`, the same file
 * the server uses) with telescope's table.
 */
export function viewerAllows(granted: readonly string[], needed: string): boolean {
  return consoleCapabilityAllows(granted, needed, TABLE);
}

/**
 * Why the viewer may not run an action needing `capability`, or `undefined` when they may (or the
 * server sent no capabilities: it still refuses what the viewer may not do).
 */
export function useViewerLacks(capability: string): string | undefined {
  const capabilities = useMeta().data?.viewer?.capabilities;
  if (capabilities === undefined || viewerAllows(capabilities, capability)) return undefined;
  return `You lack ${capability}.`;
}
