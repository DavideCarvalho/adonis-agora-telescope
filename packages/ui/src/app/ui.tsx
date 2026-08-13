import type { KeyboardEvent, ReactNode } from 'react';
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
  };
  return known[type] ?? type;
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-line bg-panel/40 p-4', className)}>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel/40 p-4">
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="tnum text-xl font-semibold tracking-tight">{value}</div>
      {sub !== undefined && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {hint !== undefined && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** The colored type badge (dot + label), tinted by {@link typeColor}. */
export function TypeBadge({ type }: { type: string }) {
  const color = typeColor(type);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 py-0.5 text-[11px] font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'currentColor' }} />
      {typeLabel(type)}
    </span>
  );
}

/** A normalized 0..1 progress bar; `color` overrides the primary fill. */
export function ShareBar({ fraction, color }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="h-1.5 min-w-[60px] overflow-hidden rounded-full bg-line" role="presentation">
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
  color = 'var(--accent)',
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

export function Skeleton({ rows = 4 }: { rows?: number | undefined }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, never reordered.
        <div key={i} className="skeleton" style={{ width: `${90 - i * 8}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">{children}</div>
  );
}

export function ErrorNote({ error }: { error: Error }) {
  return (
    <div className="px-2.5 py-5 text-center text-[13px] text-bad">
      Failed to load: {error.message}
    </div>
  );
}

/**
 * Standard load/error/empty wrapper for a data panel. Renders the skeleton while loading, an error
 * note on failure, an empty message when there is no data, else the children.
 */
export function AsyncBlock<T>({
  state,
  isEmpty,
  empty,
  skeletonRows,
  children,
}: {
  state: { data: T | null; loading: boolean; error: Error | null };
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  skeletonRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (state.error) return <ErrorNote error={state.error} />;
  if (state.loading && state.data === null) return <Skeleton rows={skeletonRows} />;
  if (state.data === null || (isEmpty?.(state.data) ?? false)) return <Empty>{empty}</Empty>;
  return <>{children(state.data)}</>;
}
