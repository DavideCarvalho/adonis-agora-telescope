import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon } from '../agora-kit/icons';
import { buttonVariants } from '../agora-kit/ui/button';
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

/** Arrow navigation over `count` options (wraps around). */
function moveIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  return current;
}

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
        className="inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-border bg-panel-2 px-2.5 text-[11px]"
        data-tenant-chip=""
      >
        <span className="hidden text-faint sm:inline">Organization</span>
        <span className="max-w-32 truncate text-fg">{only ? only.label : 'none'}</span>
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
        className={buttonVariants({ variant: 'outline', size: 'sm', className: 'max-w-56' })}
      >
        <span className="hidden text-faint sm:inline">Organization</span>
        <span className="max-w-32 truncate text-fg">{label}</span>
        <ChevronDownIcon className="text-faint" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-popover text-[13px] shadow-(--agora-shadow)">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Search organizations"
            {...(options[active] ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
            placeholder="Search organizations…"
            onKeyDown={onKeyDown}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="w-full border-b border-border bg-transparent px-3 py-2.5 text-xs text-fg outline-hidden placeholder:text-faint"
          />
          {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA listbox driven from the combobox input. */}
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && (
              <li className="px-3 py-2 text-xs text-faint">No organizations.</li>
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
                    'mx-1 flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs',
                    i === active ? 'bg-hover text-fg' : 'text-fg-2',
                    selected && 'font-medium text-brand',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.id !== ALL && option.label !== option.id && (
                    <span className="mono shrink-0 text-[10.5px] text-faint">{option.id}</span>
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
      className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-3 text-xs text-fg-2"
      role="status"
    >
      Choose an organization to see its data.
    </p>
  );
}
