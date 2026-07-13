import { useState } from 'react';
import { formatCount, formatRelative } from '../client/format.js';
import { WindowSelect } from './WindowSelect.js';
import { AsyncBlock, Panel, SectionTitle, Sparkline, clickable } from './ui.js';
import { useMetricsStats } from './use-telescope.js';

/**
 * Exception groups: `exception` entries grouped by class + message over a window, with an occurrence
 * count, a last-seen time, and an over-time sparkline. Rows deep-link into the filtered entries list.
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
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Message</th>
                  <th className="num">Count</th>
                  <th>Last seen</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {(stats.exceptions ?? []).map((group) => (
                  <tr
                    key={group.key}
                    className="row-link"
                    {...clickable(() => onOpenType('exception'))}
                  >
                    <td className="mono bad">{group.class}</td>
                    <td className="mono">{group.message}</td>
                    <td className="num tnum">{formatCount(group.count)}</td>
                    <td className="muted" title={group.lastAt}>
                      {formatRelative(group.lastAt)}
                    </td>
                    <td style={{ width: 140 }}>
                      <Sparkline values={group.overTime} width={140} height={26} color="#f87171" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBlock>
    </Panel>
  );
}
