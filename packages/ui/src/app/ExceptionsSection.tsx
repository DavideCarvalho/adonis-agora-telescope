import { useState } from 'react';
import { formatCount, formatRelative } from '../client/format.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, clickable, Panel, SectionTitle, Sparkline } from './ui.js';
import { useMetricsStats } from './use-telescope.js';
import { WindowSelect } from './WindowSelect.js';

/**
 * Exception groups: `exception` AND `client_exception` entries grouped by class + message over a
 * window, with an occurrence count, a last-seen time, and an over-time sparkline.
 *
 * A row deep-links into the entries list filtered by THAT GROUP's type. It used to hard-code
 * `exception`, which meant every click on a browser-reported error landed on a list that could not
 * contain it — "0 shown" on a row that had just said the error happened 26 times.
 */
export function ExceptionsSection({ onOpenType }: { onOpenType: (type: string) => void }) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const state = useMetricsStats('exception', windowMs);

  return (
    <Panel>
      <SectionTitle
        title="Exception groups"
        hint={<WindowSelect value={windowMs} onChange={setWindowMs} />}
      />
      <AsyncBlock
        state={state}
        isEmpty={(stats) => (stats.exceptions?.length ?? 0) === 0}
        empty="No exceptions recorded in this window. 🎉"
        skeletonRows={5}
      >
        {(stats) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Class</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stats.exceptions ?? []).map((group) => (
                <TableRow
                  key={group.key}
                  className="cursor-pointer hover:bg-brand/5"
                  {...clickable(() => onOpenType(group.type))}
                >
                  <TableCell className="mono text-bad">{group.class}</TableCell>
                  <TableCell className="mono">{group.message}</TableCell>
                  <TableCell className="tnum text-right">{formatCount(group.count)}</TableCell>
                  <TableCell className="text-muted-foreground" title={group.lastAt}>
                    {formatRelative(group.lastAt)}
                  </TableCell>
                  <TableCell style={{ width: 140 }}>
                    <Sparkline values={group.overTime} width={140} height={26} color="#f87171" />
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
