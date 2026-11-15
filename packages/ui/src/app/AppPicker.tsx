import { selectedApp } from '../client/telescope-client.js';
import type { AppScope } from '../client/types.js';
import { ScopeChip, ScopeMenu } from './ScopeMenu.js';
import { useApps } from './use-telescope.js';

/** The page URL showing `app` (`undefined` = every app), the hash route kept. */
export function urlForApp(app: string | undefined, href = window.location.href): string {
  const url = new URL(href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The label of an app id in this scope (its id when the scope does not know it). */
export function appLabel(scope: AppScope | null, id: string): string {
  return scope?.apps.find((a) => a.id === id)?.label ?? id;
}

const TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Every app you can see',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The header's "App" control, on a server that collects entries from several apps: a fixed chip
 * when the viewer sees one app, a searchable picker when it sees several or all of them. Picking
 * reloads the console with `?app=<id>`; every request then reads that app only. Hidden when no
 * entry carries an app tag (a single app's own console).
 */
export function AppPicker() {
  const { data } = useApps();
  const current = selectedApp();
  if (data === null || !data.enabled) return null;
  if (!data.all && data.apps.length <= 1) {
    const only = data.apps[0];
    return <ScopeChip noun={TEXT.noun} label={only ? only.label : 'none'} kind="app" />;
  }
  return (
    <ScopeMenu
      items={data.apps}
      all={data.all}
      current={current}
      text={TEXT}
      labelOf={(id) => appLabel(data, id)}
      onChoose={(next) => window.location.assign(urlForApp(next))}
    />
  );
}

/** Shown instead of data when the viewer is limited to apps and has none to look at. */
export function AppEmptyNotice() {
  const { data } = useApps();
  if (data === null || !data.enabled || data.all || data.apps.length > 0) return null;
  return (
    <p
      className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-3 text-xs text-fg-2"
      role="status"
    >
      You have no app to look at here.
    </p>
  );
}
