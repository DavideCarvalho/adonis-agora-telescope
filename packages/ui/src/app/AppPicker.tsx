import {
  AppModeBadge,
  actionsUnavailableReason,
  FederatedNotice,
} from '../agora-kit/blocks/app-mode';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { selectedApp } from '../client/telescope-client.js';
import type { AppOption, AppScope } from '../client/types.js';
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
  const picked = current === undefined ? undefined : data.apps.find((a) => a.id === current);
  const badge = picked ? (
    <AppModeBadge appLabel={picked.label} mode={picked.mode} actions={picked.actions} />
  ) : null;
  if (!data.all && data.apps.length <= 1) {
    const only = data.apps[0];
    return (
      <div className="flex items-center gap-1.5" data-app-picker>
        <ScopeChip noun={TEXT.noun} label={only ? only.label : 'none'} kind="app" />
        {only && <AppModeBadge appLabel={only.label} mode={only.mode} actions={only.actions} />}
      </div>
    );
  }
  // With federated apps listed, "everything" is this console's own entries: name it.
  const local = data.local?.label;
  const text = local ? { ...TEXT, all: local, some: local } : TEXT;
  return (
    <div className="flex items-center gap-1.5" data-app-picker>
      <ScopeMenu
        items={data.apps.map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.mode === 'federated' ? { hint: 'federated' } : {}),
        }))}
        all={data.all}
        current={current}
        text={text}
        labelOf={(id) => appLabel(data, id)}
        onChoose={(next) => window.location.assign(urlForApp(next))}
      />
      {badge}
    </div>
  );
}

/** The picked app (`?app=`) as `/apps` lists it, or undefined. */
export function usePickedApp(): AppOption | undefined {
  const { data } = useApps();
  const current = selectedApp();
  if (current === undefined || data === null || !Array.isArray(data.apps)) return undefined;
  return data.apps.find((a) => a.id === current);
}

/**
 * Why actions (replay, queue retry/enqueue) are unavailable for the picked app, or undefined
 * when they are: a federated app this console only browses.
 */
export function useAppActionsUnavailable(): string | undefined {
  const app = usePickedApp();
  return app ? actionsUnavailableReason(app.label, app) : undefined;
}

/** The strip at the top of every page while a federated app is picked: whose data, who acts. */
export function FederatedAppNotice() {
  const app = usePickedApp();
  if (!app) return null;
  return <FederatedNotice appLabel={app.label} mode={app.mode} actions={app.actions} />;
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
