import { formatDuration, formatRelative } from '../client/format.js';
import { AsyncBlock, Panel, SectionTitle, clickable, typeColor } from './ui.js';
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
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Trace</th>
                  <th>Types</th>
                  <th className="num">Entries</th>
                  <th className="num">Total</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t) => (
                  <tr
                    key={t.traceId}
                    className="row-link"
                    {...clickable(() => onOpenTrace(t.traceId))}
                  >
                    <td className="mono">{t.rootLabel ?? t.traceId.slice(0, 16)}</td>
                    <td>
                      <span className="controls" style={{ gap: 5 }}>
                        {t.types.map((type) => (
                          <span
                            key={type}
                            className="swatch"
                            title={type}
                            style={{ background: typeColor(type), borderRadius: 999 }}
                          />
                        ))}
                      </span>
                    </td>
                    <td className="num tnum">{t.entryCount}</td>
                    <td className="num tnum">{formatDuration(t.totalDurationMs)}</td>
                    <td className="muted" title={t.lastAt}>
                      {formatRelative(t.lastAt)}
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
