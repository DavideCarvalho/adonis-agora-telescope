import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { moveIndex } from '../client/console_switcher.js';
import { selectedTenant } from '../client/telescope-client.js';
import type { TenantOption, TenantScope } from '../client/types.js';
import { cn } from './primitives/cn.js';
import { useTenants } from './use-telescope.js';

/** The page URL showing `tenant` (`undefined` = every organization), the hash route kept. */
export function urlForTenant(tenant: string | undefined, href = window.location.href): string {
  const url = new URL(href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The label of a tenant id in this scope (its id when the scope does not know it). */
export function tenantLabel(scope: TenantScope | null, id: string): string {
  return (
    scope?.tenants.find((t) => t.id === id)?.label ?? (scope?.own?.id === id ? scope.own.label : id)
  );
}

const ALL = '*';

/**
 * The header's "Organization" control: a fixed chip when the viewer sees one organization, a
 * searchable picker when it sees several or all of them. Picking reloads the console with
 * `?tenant=<id>`; every request then reads that organization only.
 */
export function TenantPicker() {
  const { data } = useTenants();
  const current = selectedTenant();
  if (data === null || !data.enabled) return null;
  if (!data.all && data.tenants.length <= 1) {
    const only = data.tenants[0];
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1 text-xs"
        data-tenant-chip=""
      >
        <span className="text-muted-foreground">Organization</span>
        <span>{only ? only.label : 'none'}</span>
      </span>
    );
  }
  return <TenantMenu scope={data} current={current} />;
}

function TenantMenu({ scope, current }: { scope: TenantScope; current: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo<TenantOption[]>(() => {
    const base = scope.all
      ? [{ id: ALL, label: 'All organizations' }, ...scope.tenants]
      : scope.tenants;
    const q = query.trim().toLowerCase();
    return q === ''
      ? base
      : base.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [scope, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const choose = (option: TenantOption | undefined) => {
    if (!option) return;
    setOpen(false);
    const next = option.id === ALL ? undefined : option.id;
    if (next !== current) window.location.assign(urlForTenant(next));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => moveIndex(i, event.key, options.length));
    }
  };

  const label =
    current === undefined
      ? scope.all
        ? 'All organizations'
        : 'Every organization you can see'
      : tenantLabel(scope, current);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1 text-xs hover:bg-panel"
      >
        <span className="text-muted-foreground">Organization</span>
        <span className="max-w-40 truncate">{label}</span>
        <span className="text-muted-foreground" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-panel-2 text-[13px]"
          onKeyDown={onKeyDown}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Search organizations"
            {...(options[active] ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
            placeholder="Search organizations…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="w-full border-b border-line bg-transparent px-3 py-2 text-xs outline-hidden placeholder:text-muted-foreground"
          />
          {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA listbox driven from the combobox input. */}
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground">No organizations.</li>
            )}
            {options.map((option, i) => {
              const selected = option.id === ALL ? current === undefined : option.id === current;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input.
                <li
                  key={option.id}
                  id={`${listId}-${i}`}
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA option.
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(option);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5',
                    i === active ? 'bg-panel text-brand' : 'text-foreground',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.id !== ALL && option.label !== option.id && (
                    <span className="mono shrink-0 text-[11px] text-muted-foreground">
                      {option.id}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Shown instead of data when tenancy is on and the viewer has no organization to look at. */
export function TenantEmptyNotice() {
  const { data } = useTenants();
  if (data === null || !data.enabled || data.all || data.tenants.length > 0) return null;
  return (
    <p
      className="mb-4 rounded-md border border-line px-4 py-3 text-xs text-muted-foreground"
      role="status"
    >
      Choose an organization to see its data.
    </p>
  );
}
