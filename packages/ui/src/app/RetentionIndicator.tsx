import type { RetentionInfo } from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Tooltip } from './primitives/tooltip.js';
import { useRetention } from './use-telescope.js';

/** Coarsest-unit duration label for a ms span: `2d`, `6h`, `45m`, `30s`. Unlike
 *  {@link formatWindow} in `client/format.ts` this also handles sub-minute spans, which a
 *  retention window can legitimately be in a test/dev config. */
function formatRetentionWindow(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return `${Math.round(days)}d`;
}

/** A short "why counts might undercount reality" tooltip: the first sampled type found. */
function samplingNote(sampling: RetentionInfo['sampling']): string | null {
  const first = sampling[0];
  if (!first) return null;
  const suffix = sampling.length > 1 ? ` (+${sampling.length - 1} more)` : '';
  return `${first.type} sampled @ ${Math.round(first.rate * 100)}%${suffix}`;
}

/**
 * A small header-level status chip: how long entries are kept before pruning (or "no pruning"
 * configured), plus a `?` badge when any entry type is tail-sampled below 100% (so displayed
 * counts may undercount what actually happened). Purely informational.
 */
export function RetentionIndicator() {
  const state = useRetention();
  if (state.loading || state.error || !state.data) return null;
  const { enabled, afterMs, sampling } = state.data;
  const note = samplingNote(sampling);
  const label = enabled ? formatRetentionWindow(afterMs) : 'none';
  const title = enabled
    ? `Entries older than ${formatRetentionWindow(afterMs)} are pruned.`
    : 'No retention pruning configured.';

  return (
    <Tooltip label={title}>
      <span className="mono inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted-foreground">
        retention: {label}
        {note && (
          <Badge variant="warn" className="ml-0.5 rounded-full px-1.5" title={note}>
            ?
          </Badge>
        )}
      </span>
    </Tooltip>
  );
}
