import { formatDuration, formatRelative } from '../client/format.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, clickable, Panel, SectionTitle, typeColor } from './ui.js';
import { useTraces } from './use-telescope.js';

/** The recent-traces list: root label, the type mix (colored dots), entry count, total time. */
export function TracesSection({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const state = useTraces(80);
  return (
    <Panel>
      <SectionTitle title="Traces" hint="recent, newest-active first" />
      <AsyncBlock
        state={state}
        isEmpty={(traces) => traces.length === 0}
        empty="No traces recorded yet."
        skeletonRows={6}
      >
        {(traces) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trace</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Types</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traces.map((t) => (
                <TableRow
                  key={t.traceId}
                  className="cursor-pointer hover:bg-brand/5"
                  {...clickable(() => onOpenTrace(t.traceId))}
                >
                  <TableCell className="mono">{t.rootLabel ?? t.traceId.slice(0, 16)}</TableCell>
                  <TableCell className="text-muted-foreground">{t.userLabel ?? '—'}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      {t.types.map((type) => (
                        <span
                          key={type}
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          title={type}
                          style={{ background: typeColor(type) }}
                        />
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="tnum text-right">{t.entryCount}</TableCell>
                  <TableCell className="tnum text-right">
                    {formatDuration(t.totalDurationMs)}
                  </TableCell>
                  <TableCell className="text-muted-foreground" title={t.lastAt}>
                    {formatRelative(t.lastAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AsyncBlock>
    </Panel>
  );
}
