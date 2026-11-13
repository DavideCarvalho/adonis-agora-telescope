// Ported from `nestjs-telescope`'s `packages/ui/src/react/components/flamegraph-view.tsx`, restyled
// onto this package's Tailwind tokens/primitives (no `chart-svg`/hand-rolled classes — the div-based
// icicle rendering technique itself is unchanged, since it has nothing NestJS-specific about it).
import { useMemo, useState } from 'react';
import type { FlameNode } from '../client/types.js';
import { flameColor, flameDepth, flattenFlame, formatProfileMs } from './flamegraph.js';

const ROW_HEIGHT = 18;

/**
 * A dependency-light flamegraph (icicle layout, root at top). Renders one absolutely-positioned
 * `<div>` per visible frame — no canvas, no charting library — sized as a percentage of the
 * container width so it's responsive. Clicking a frame "zooms" to make it the new 100%-width root;
 * click the reset control to zoom back out.
 */
export function Flamegraph({ tree }: { tree: FlameNode }) {
  // Zoom focus: the path key of the frame currently treated as the root.
  const [focusKey, setFocusKey] = useState('0');

  const cells = useMemo(() => flattenFlame(tree), [tree]);
  const depth = flameDepth(cells);

  // Resolve the focused subtree's x/width so we can rescale all cells to it.
  const focus = cells.find((c) => c.key === focusKey) ?? cells[0];
  const focusX = focus?.x ?? 0;
  const focusWidth = focus?.width ?? 1;
  const focusDepth = focus?.depth ?? 0;

  if (tree.totalMs <= 0 || cells.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-faint">
        No samples — the capture was empty.
      </div>
    );
  }

  // Only render cells inside the focused subtree (its descendants), rescaled.
  const visible = cells.filter((c) => c.key === focusKey || c.key.startsWith(`${focusKey}.`));
  const rows = depth - focusDepth;

  return (
    <div>
      {focusKey !== '0' && (
        <button
          type="button"
          onClick={() => setFocusKey('0')}
          className="mb-2 rounded-[6px] border border-border bg-panel-2 px-2 py-0.5 text-[11px] text-dim transition-colors hover:text-fg"
        >
          ← Reset zoom
        </button>
      )}
      <div
        data-testid="flamegraph"
        className="relative w-full overflow-hidden rounded-lg border border-border bg-sunken/30"
        style={{ height: rows * ROW_HEIGHT + 2 }}
      >
        {visible.map((cell) => {
          const left = ((cell.x - focusX) / focusWidth) * 100;
          const width = (cell.width / focusWidth) * 100;
          const top = (cell.depth - focusDepth) * ROW_HEIGHT;
          const pct = ((cell.node.totalMs / tree.totalMs) * 100).toFixed(1);
          return (
            <button
              type="button"
              key={cell.key}
              onClick={() => setFocusKey(cell.key)}
              title={`${cell.node.name}${cell.node.file ? ` — ${cell.node.file}` : ''}\ntotal ${formatProfileMs(
                cell.node.totalMs,
              )} (${pct}%) · self ${formatProfileMs(cell.node.selfMs)}`}
              className="mono absolute flex items-center overflow-hidden border border-black/10 px-1 text-left text-[10px] leading-none text-black/80 hover:brightness-110"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top,
                height: ROW_HEIGHT - 1,
                background:
                  cell.node.name === '(root)' ? 'var(--agora-line)' : flameColor(cell.node.name),
              }}
            >
              <span
                className="truncate"
                style={cell.node.name === '(root)' ? { color: 'var(--agora-text)' } : {}}
              >
                {cell.node.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
