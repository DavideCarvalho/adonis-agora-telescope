import { type CSSProperties, type ReactNode, Suspense, useEffect, useMemo } from 'react';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { AppShell, type NavSection, PageBody } from '../agora-kit/shell/app-shell';
import type { SearchCommand } from '../agora-kit/shell/console-search';
import { readShellConfig } from '../agora-kit/shell-config';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { CONFIG_ELEMENT_ID } from '../client/api-base.js';
import type { DashboardSpec, ExtensionEntryType } from '../client/types.js';
import { ENTRY_TYPES } from '../client/types.js';
import { buildCommands, type CommandTarget } from './commands.js';
import {
  AiIcon,
  ClockIcon,
  DashboardIcon,
  EntriesIcon,
  ExceptionIcon,
  ExportIcon,
  FlameIcon,
  OverviewIcon,
  PulseIcon,
  QueueIcon,
  ScreensIcon,
  TelescopeMark,
  TracesIcon,
} from './icons.js';
import { lazySection } from './lazy-section.js';
import { OverviewSection } from './OverviewSection.js';
import { RetentionIndicator } from './RetentionIndicator.js';
import { TenantEmptyNotice, TenantPicker } from './TenantPicker.js';
import { typeColor, typeLabel } from './ui.js';
import { formatHash, type TelescopeRoute, useHashRoute } from './use-hash-route.js';
import { useMeta } from './use-telescope.js';

/** Telescope's accent (magenta): passed to the kit's ThemeProvider in `main.tsx`. */
export const TELESCOPE_ACCENT = '#e879f9';

// Every section except the landing Overview is its own chunk (loaded on first visit), so the
// initial page only downloads and parses the shell + Overview.
const AiSection = lazySection(() => import('./AiSection.js'), 'AiSection');
const EntriesSection = lazySection(() => import('./EntriesSection.js'), 'EntriesSection');
const EntryDetail = lazySection(() => import('./EntryDetail.js'), 'EntryDetail');
const ExceptionsSection = lazySection(() => import('./ExceptionsSection.js'), 'ExceptionsSection');
const ExportsSection = lazySection(() => import('./ExportsSection.js'), 'ExportsSection');
const ExtensionsSection = lazySection(() => import('./ExtensionsSection.js'), 'ExtensionsSection');
const ProfilesSection = lazySection(() => import('./ProfilesSection.js'), 'ProfilesSection');
const PulseSection = lazySection(() => import('./PulseSection.js'), 'PulseSection');
const QueueManagerSection = lazySection(
  () => import('./QueueManagerSection.js'),
  'QueueManagerSection',
);
const SchedulesLiveSection = lazySection(
  () => import('./SchedulesLiveSection.js'),
  'SchedulesLiveSection',
);
const ScreensSection = lazySection(() => import('./ScreensSection.js'), 'ScreensSection');
const TraceDetail = lazySection(() => import('./TraceDetail.js'), 'TraceDetail');
const TracesSection = lazySection(() => import('./TracesSection.js'), 'TracesSection');

type SectionKey =
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

/** Topbar titles per route. */
const TITLES: Record<TelescopeRoute['name'], string> = {
  overview: 'Overview',
  pulse: 'Pulse',
  exceptions: 'Exceptions',
  entries: 'Entries',
  entry: 'Entry',
  traces: 'Traces',
  trace: 'Trace',
  screens: 'Screens',
  ai: 'AI',
  profiles: 'Profiles',
  queues: 'Queues',
  schedules: 'Schedules',
  exports: 'Exports',
  extensions: 'Dashboards',
};

/** A watcher/entry-type nav row: built-ins from `ENTRY_TYPES` plus anything an extension
 *  contributed via `/api/meta` (e.g. `adonis-durable`'s "Workflows" type), de-duped by id. */
function watcherTypes(
  contributed: ExtensionEntryType[] | undefined,
): { id: string; label: string; dot: string }[] {
  const built = ENTRY_TYPES.map((id) => ({ id, label: typeLabel(id), dot: typeColor(id) }));
  const builtIds = new Set<string>(ENTRY_TYPES);
  const extra = (contributed ?? []).filter((c) => !builtIds.has(c.id));
  return [...built, ...extra];
}

/** A watcher's colour dot, sized like a nav icon so the labels line up with the rows above. */
function Dot({ color }: { color: string }) {
  return (
    <span className="grid size-[15px] shrink-0 place-items-center" aria-hidden>
      <span
        className="type-ink size-[7px] rounded-full bg-current"
        style={{ '--type': color } as CSSProperties}
      />
    </span>
  );
}

/** The sidebar row a route lights up. A filtered entries list lights its watcher. */
function activeNavId(route: TelescopeRoute): string {
  switch (route.name) {
    case 'entry':
      return 'entries';
    case 'trace':
      return 'traces';
    case 'entries':
      return route.type === undefined ? 'entries' : `watcher:${route.type}`;
    case 'extensions':
      return route.dashboardId ? `dashboard:${route.dashboardId}` : 'extensions';
    default:
      return route.name;
  }
}

/**
 * The sidebar: MONITOR (Overview, Pulse, Exceptions) · EXPLORE (Entries, Traces, Screens, AI,
 * Profiles) · OPERATIONS (Queues, Schedules) · DASHBOARDS (one item per contributed dashboard, under
 * its own name — never a generic "Extensions" entry) · WATCHERS (a collapsible dot list) · DATA.
 */
function buildNav(
  go: (route: TelescopeRoute) => void,
  dashboards: DashboardSpec[],
  watchers: { id: string; label: string; dot: string }[],
): NavSection[] {
  const page = (key: SectionKey, label: string, icon: ReactNode) => ({
    id: key,
    label,
    icon,
    href: formatHash({ name: key }),
    onSelect: () => go({ name: key }),
  });
  return [
    {
      section: 'Monitor',
      items: [
        page('overview', 'Overview', <OverviewIcon />),
        page('pulse', 'Pulse', <PulseIcon />),
        page('exceptions', 'Exceptions', <ExceptionIcon />),
      ],
    },
    {
      section: 'Explore',
      items: [
        page('entries', 'Entries', <EntriesIcon />),
        page('traces', 'Traces', <TracesIcon />),
        page('screens', 'Screens', <ScreensIcon />),
        page('ai', 'AI', <AiIcon />),
        page('profiles', 'Profiles', <FlameIcon />),
      ],
    },
    {
      section: 'Operations',
      items: [
        page('queues', 'Queues', <QueueIcon />),
        page('schedules', 'Schedules', <ClockIcon />),
      ],
    },
    {
      section: 'Dashboards',
      items: dashboards.map((d) => {
        const route: TelescopeRoute = { name: 'extensions', dashboardId: d.id };
        return {
          id: `dashboard:${d.id}`,
          label: d.label,
          icon: <DashboardIcon />,
          href: formatHash(route),
          onSelect: () => go(route),
        };
      }),
    },
    {
      section: 'Watchers',
      collapsible: true,
      items: watchers.map((w) => {
        const route: TelescopeRoute = { name: 'entries', type: w.id };
        return {
          id: `watcher:${w.id}`,
          label: w.label,
          icon: <Dot color={w.dot} />,
          href: formatHash(route),
          onSelect: () => go(route),
        };
      }),
    },
    { section: 'Data', items: [page('exports', 'Exports', <ExportIcon />)] },
  ];
}

/** The topbar's live indicator: Telescope is recording right now. */
function LiveIndicator() {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-good/25 bg-good/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-good sm:inline-flex"
      title="Telescope is capturing live"
    >
      <span className="live-dot" aria-hidden />
      Live
    </span>
  );
}

/** What a lazily-loaded page shows while its chunk downloads: metric tiles and a panel. */
function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
      <MetricGridSkeleton count={4} />
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  );
}

/**
 * The Telescope console: the Agora shell (kit) — sidebar with the console switcher, grouped nav and
 * a collapsible watcher list; topbar with the organization picker, retention, the live dot and
 * ⌘K — around the active page. Every page renders inside its own error boundary, and the panels
 * inside a page fetch and fail on their own.
 *
 * Routing stays on the URL hash (`#/entries?type=…`, `#/entries/<id>`, `#/traces/<id>` …): it is
 * the single source of truth, so deep links, browser back/forward and programmatic navigation all
 * converge on the same state. A selected entry or trace replaces the page with its detail view.
 */
export function App() {
  const { route, navigate } = useHashRoute();
  const meta = useMeta();
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);

  // On first load with an empty hash, land on the overview (also gives the URL a deep-linkable
  // hash so a plain page visit doesn't fight the route parse).
  useEffect(() => {
    if (window.location.hash === '') window.location.hash = '#/overview';
  }, []);

  const go = (key: SectionKey) => navigate({ name: key });
  const openEntry = (id: string) => navigate({ name: 'entry', id });
  const openTrace = (traceId: string) => navigate({ name: 'trace', traceId });
  const openType = (type: string) => navigate({ name: 'entries', type });

  const goBack = (fallback: 'entries' | 'traces') => {
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
    else navigate({ name: fallback });
  };

  const dashboards = meta.data?.dashboards ?? [];
  const contributedTypes = meta.data?.entryTypes;
  const watchers = useMemo(() => watcherTypes(contributedTypes), [contributedTypes]);
  const nav = useMemo(
    () => buildNav(navigate, dashboards, watchers),
    [navigate, dashboards, watchers],
  );

  // ⌘K: Telescope's own jumps (every page, every entry type, every contributed dashboard) above
  // the cross-console search the provider announced.
  const commands = useMemo<SearchCommand[]>(
    () =>
      buildCommands(dashboards).map((c) => ({
        id: c.id,
        label: c.label,
        group: c.group,
        hint: c.hint,
        ...(c.dot ? { icon: <Dot color={c.dot} /> } : {}),
        onSelect: () => navigate(routeFor(c.target)),
      })),
    [dashboards, navigate],
  );

  const dashboardLabel =
    route.name === 'extensions'
      ? dashboards.find((d) => d.id === route.dashboardId)?.label
      : undefined;
  const title =
    route.name === 'entries' && route.type !== undefined
      ? `Entries · ${typeLabel(route.type)}`
      : (dashboardLabel ?? TITLES[route.name]);

  return (
    <AppShell
      brand={{
        name: 'telescope',
        subtitle: 'observability',
        mark: <TelescopeMark />,
        current: { title: 'Telescope', package: '@adonis-agora/telescope', icon: 'telescope' },
      }}
      nav={nav}
      activeId={activeNavId(route)}
      shell={shell}
      title={title}
      commands={commands}
      searchPlaceholder={
        shell.search ? 'Jump to a page, or search entries, runs, users…' : 'Jump to a page…'
      }
      actions={
        <>
          <TenantPicker />
          <div className="hidden md:block">
            <RetentionIndicator />
          </div>
          <LiveIndicator />
        </>
      }
    >
      <PageBody>
        <TenantEmptyNotice />
        <ErrorBoundary label={TITLES[route.name]} resetKeys={[formatHash(route)]}>
          <Suspense fallback={<PageSkeleton />}>
            {route.name === 'entry' ? (
              <EntryDetail id={route.id} onOpenTrace={openTrace} onBack={() => goBack('entries')} />
            ) : route.name === 'trace' ? (
              <TraceDetail
                traceId={route.traceId}
                onOpenEntry={openEntry}
                onBack={() => goBack('traces')}
              />
            ) : route.name === 'overview' ? (
              <OverviewSection
                onOpenTrace={openTrace}
                onOpenEntry={openEntry}
                onOpenQueues={() => go('queues')}
                onOpenPulse={() => go('pulse')}
                onOpenExceptions={() => go('exceptions')}
                onOpenType={openType}
              />
            ) : route.name === 'pulse' ? (
              <PulseSection onOpenTrace={openTrace} />
            ) : route.name === 'entries' ? (
              <EntriesSection
                key={route.type ?? 'default'}
                onOpenEntry={openEntry}
                onOpenTrace={openTrace}
                {...(route.type !== undefined ? { presetType: route.type } : {})}
              />
            ) : route.name === 'screens' ? (
              <ScreensSection onOpenType={openType} />
            ) : route.name === 'ai' ? (
              <AiSection onOpenTrace={openTrace} onOpenEntry={openEntry} />
            ) : route.name === 'traces' ? (
              <TracesSection onOpenTrace={openTrace} />
            ) : route.name === 'exceptions' ? (
              <ExceptionsSection onOpenType={openType} />
            ) : route.name === 'schedules' ? (
              <SchedulesLiveSection />
            ) : route.name === 'queues' ? (
              <QueueManagerSection />
            ) : route.name === 'profiles' ? (
              <ProfilesSection />
            ) : route.name === 'exports' ? (
              <ExportsSection />
            ) : (
              <ExtensionsSection
                selectedId={route.dashboardId ?? null}
                onSelect={(id) => navigate({ name: 'extensions', dashboardId: id })}
                onOpenTrace={openTrace}
              />
            )}
          </Suspense>
        </ErrorBoundary>
      </PageBody>
    </AppShell>
  );
}

/** The route a ⌘K command lands on. */
function routeFor(target: CommandTarget): TelescopeRoute {
  if (target.kind === 'section') return { name: target.key };
  if (target.kind === 'entryType') return { name: 'entries', type: target.type };
  return { name: 'extensions', dashboardId: target.id };
}
