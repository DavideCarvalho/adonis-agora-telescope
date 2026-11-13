import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { ErrorBoundary, RegionError } from '../agora-kit/blocks/error-boundary';
import { InboxIcon } from '../agora-kit/icons';
import { Skeleton as KitSkeleton } from '../agora-kit/ui/skeleton';
import { cn } from './primitives/cn.js';

/**
 * Shared view helpers for every section — ported from hand-rolled `.panel`/`.badge`/`.bar`/`.empty`
 * CSS classes to Tailwind utilities + the vendored `./primitives` on Base UI, matching
 * `@dudousxd/nestjs-telescope-ui`'s equivalents. Every export keeps its ORIGINAL name and signature
 * so call sites across the app didn't need to change, only what each renders internally.
 */

/**
 * Props that make a non-button element (a table row, a waterfall row) keyboard-activatable: a click
 * handler plus Enter/Space key support and the `button` role + `tabIndex`, so the whole SPA's
 * row-as-control affordance stays accessible without repeating the boilerplate (or suppressing the
 * a11y lint) at every call site.
 */
export function clickable(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

/**
 * A stable, high-contrast color per entry type — used for the type badge dot, the trace-type dots,
 * and the waterfall bars, so a `query` span reads the same everywhere. Unknown types fall back to a
 * neutral tone.
 */
export const TYPE_COLORS: Record<string, string> = {
  request: '#34d399',
  query: '#38bdf8',
  exception: '#f87171',
  client_exception: '#fb923c',
  job: '#a78bfa',
  mail: '#f472b6',
  cache: '#2dd4bf',
  redis: '#fb7185',
  event: '#818cf8',
  log: '#94a3b8',
  'http-client': '#fbbf24',
  diagnostic: '#22d3ee',
  span: '#a3e635',
};

const FALLBACK_COLOR = '#8b8b97';

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? FALLBACK_COLOR;
}

/** A human label for an entry type (`http-client` → `HTTP client`, `client_exception` → …). */
export function typeLabel(type: string): string {
  const known: Record<string, string> = {
    'http-client': 'HTTP client',
    client_exception: 'client exception',
    span: 'OTel span',
  };
  return known[type] ?? type;
}

/**
 * A card (kit `Panel` look: top-lit surface, hairline border). A {@link SectionTitle} as its first
 * child becomes the card's header row, ruled off from the body like the kit's titled `Panel`.
 */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        'agora-surface agora-rise min-w-0 rounded-lg border border-border p-4 has-[>[data-panel-title]]:pt-0',
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * A headline number (kit `MetricCard` look: CAPS label, big mono number, mono caption).
 *
 * `onClick` makes it a real button that navigates to wherever the number can be
 * broken down. A tile that says "Slow routes: 4" and cannot be opened states a
 * problem and hides the evidence — the reader's next move is obvious and the UI
 * refuses it. Every counting tile should either be clickable or not worth showing.
 */
export function Stat({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Where this number breaks down. Renders the tile as a button when present. */
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      <div className="mono tnum text-[24px] font-semibold leading-none tracking-[-0.02em] text-fg">
        {value}
      </div>
      {sub !== undefined && (
        <div className="mono mt-2 truncate text-[10.5px] text-faint">{sub}</div>
      )}
    </>
  );
  const tile =
    'agora-surface agora-rise min-w-0 rounded-lg border border-border px-[18px] pt-4 pb-3.5 text-left';

  if (onClick === undefined) {
    return <div className={tile}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        tile,
        'cursor-pointer transition-colors hover:border-brand-border hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
      )}
    >
      {body}
    </button>
  );
}

/** A responsive row of {@link Stat} tiles: two per row on a phone, `cols` on a desktop. */
export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3', cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
      {children}
    </div>
  );
}

/**
 * The empty state for a panel whose data source is switched off.
 *
 * Distinct from {@link Empty} on purpose. "No N+1 loops detected 🎉" and "the `query`
 * watcher is off" are opposite claims, and a panel that renders the first when the
 * second is true reports its own blindness in the voice of good news — the reader
 * walks away reassured about something nobody measured. Every panel that depends on
 * an optional watcher should be able to say which one, and where to turn it on.
 */
export function WatcherOff({ watcher, config }: { watcher: string; config: string }) {
  return (
    <div className="rounded-md border border-dashed border-line-strong bg-warn/5 px-3 py-3.5 text-[12.5px] leading-relaxed text-dim">
      <span className="font-medium text-warn">Not measured.</span> The{' '}
      <code className="mono text-fg">{watcher}</code> watcher is not enabled, so this panel has no
      data to show — which is not the same as nothing being wrong. Add{' '}
      <code className="mono text-fg">'{watcher}'</code> to{' '}
      <code className="mono text-fg">{config}</code> to start recording it.
    </div>
  );
}

/** A panel's header row: title left, mono meta (`hint`) right, ruled off from the body. */
export function SectionTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div
      data-panel-title=""
      className="-mx-4 mb-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3"
    >
      <h3 className="m-0 text-[12.5px] font-semibold tracking-[0.02em] text-fg">{title}</h3>
      {hint !== undefined && (
        <span className="mono flex min-w-0 items-center gap-2 text-[10.5px] text-faint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** A page's title block (kit `PageHeader`): title, one-line subtitle, actions on the right. */
export { PageHeader } from '../agora-kit/blocks/page-header';

/** The colored type badge (dot + label), tinted by {@link typeColor}. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className="type-chip mono inline-flex h-[18px] items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[10px] font-medium"
      style={typeStyle(type)}
    >
      <span className="size-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {typeLabel(type)}
    </span>
  );
}

/** Inline style that hands an entry type's hue to `.type-ink` / `.type-chip` (`--type`). */
export function typeStyle(type: string): CSSProperties {
  return { '--type': typeColor(type) } as CSSProperties;
}

/** A normalized 0..1 progress bar; `color` overrides the primary fill. */
export function ShareBar({ fraction, color }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className="h-1.5 min-w-[60px] overflow-hidden rounded-full bg-line-strong/60"
      role="presentation"
    >
      <span
        className="block h-full rounded-full bg-brand"
        style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  );
}

/**
 * A dependency-free SVG sparkline over a numeric series. Renders a filled area under a stroked line;
 * an all-zero / empty series renders a flat baseline. `color` defaults to the brand accent.
 */
export function Sparkline({
  values,
  width = 320,
  height = 40,
  color = 'var(--agora-accent-ink)',
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const n = values.length;
  if (n === 0) return <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" />;
  const max = Math.max(1, ...values);
  const stepX = n > 1 ? width / (n - 1) : 0;
  const y = (v: number) => height - (v / max) * (height - 2) - 1;
  const points = values.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${points.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="sparkline"
    >
      <path d={area} fill={color} opacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/** Shaped placeholder lines for a panel body while its data loads (kit `Skeleton`). */
export function Skeleton({ rows = 4 }: { rows?: number | undefined }) {
  return (
    <div className="flex flex-col gap-3 py-1" aria-hidden data-skeleton="">
      {Array.from({ length: rows }, (_, i) => `skeleton-${i}`).map((key, i) => (
        <KitSkeleton
          key={key}
          className="h-3.5 bg-line-strong/50"
          style={{ width: `${90 - i * 8}%` }}
        />
      ))}
    </div>
  );
}

/** A panel's compact empty state: an inbox glyph and one line. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2.5 py-6 text-center text-[12.5px] text-faint">
      <span className="grid size-8 place-items-center rounded-md border border-border bg-panel-2 text-faint [&_svg]:size-4">
        <InboxIcon />
      </span>
      {children}
    </div>
  );
}

/** A region's load failure: what failed, the message, and a retry when the region can refetch. */
export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return <RegionError title="Failed to load" error={error} onRetry={onRetry} />;
}

/**
 * Standard load/error/empty wrapper for a data region: a shaped skeleton while loading, a
 * retryable error on failure, an empty message when there is no data, else the children — inside
 * an error boundary, so a render crash stays in this region instead of blanking the page.
 */
export function AsyncBlock<T>({
  state,
  isEmpty,
  empty,
  skeletonRows,
  skeleton,
  children,
}: {
  state: { data: T | null; loading: boolean; error: Error | null; reload?: () => void };
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  skeletonRows?: number;
  /** A skeleton shaped like the final layout; defaults to `skeletonRows` placeholder lines. */
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.error && state.data === null) {
    return <ErrorNote error={state.error} {...(state.reload ? { onRetry: state.reload } : {})} />;
  }
  if (state.loading && state.data === null)
    return <>{skeleton ?? <Skeleton rows={skeletonRows} />}</>;
  if (state.data === null || (isEmpty?.(state.data) ?? false)) return <Empty>{empty}</Empty>;
  const data = state.data;
  return (
    <ErrorBoundary {...(state.reload ? { onReset: state.reload } : {})}>
      {children(data)}
    </ErrorBoundary>
  );
}
