import { useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  type ConsoleLink,
  getJson,
  moveIndex,
  parseConsoles,
  readShellSwitcherConfig,
} from '../client/console_switcher.js';
import { ConsoleIcon } from './console-switcher-icons.js';
import { cn } from './primitives/cn.js';

/**
 * The other `@adonis-agora` consoles this viewer may open. Asked once per page life, and only when
 * the shell announced other consoles (`switcher` in the data block).
 */
export function useConsoles(
  endpoint = readShellSwitcherConfig().switcher?.endpoint,
): ConsoleLink[] {
  const { data } = useQuery({
    queryKey: ['agora-consoles', endpoint],
    queryFn: async ({ signal }) => parseConsoles(await getJson(endpoint as string, signal)),
    enabled: typeof endpoint === 'string',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return data ?? [];
}

/**
 * The sidebar brand. With other consoles to open it becomes the switcher: a menu button listing this
 * console first (checked, not a link) and then the others, each a plain same-origin link.
 */
export function ConsoleSwitcher({ brand, endpoint }: { brand: ReactNode; endpoint?: string }) {
  const consoles = useConsoles(endpoint ?? readShellSwitcherConfig().switcher?.endpoint);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, close]);

  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  if (consoles.length === 0) {
    return (
      <div className="px-3" data-agora-switcher="">
        {brand}
      </div>
    );
  }

  const openMenu = () => {
    setOpen(true);
    setActive(0);
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    const next = moveIndex(active, event.key, consoles.length);
    if (next !== active) {
      event.preventDefault();
      setActive(next);
    }
  };

  return (
    <div className="relative" data-agora-switcher="" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="flex w-full items-center gap-2 rounded px-3 py-1 text-left hover:bg-panel focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKey}
      >
        {brand}
        <svg
          className={cn('ml-auto text-muted-foreground transition-transform', open && 'rotate-180')}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Consoles"
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-50 mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-panel-2 py-1 text-[13px]"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-foreground" role="none">
            <ConsoleIcon icon="telescope" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>Telescope</span>
              <span className="truncate text-[11px] text-muted-foreground">
                @adonis-agora/telescope
              </span>
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-label="Current console"
              role="img"
              className="text-brand"
            >
              <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {consoles.map((item, index) => (
            <a
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="menuitem"
              tabIndex={index === active ? 0 : -1}
              href={item.href}
              onFocus={() => setActive(index)}
              className="flex items-center gap-2 px-3 py-2 text-foreground outline-hidden hover:bg-panel focus:bg-panel"
            >
              <ConsoleIcon icon={item.icon} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{item.title}</span>
                {item.package && (
                  <span className="truncate text-[11px] text-muted-foreground">{item.package}</span>
                )}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
