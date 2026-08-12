import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from '../icons.js';
import { Button } from './button.js';
import { cn } from './cn.js';

/**
 * Base UI Dialog — the command palette's overlay. One primitive layer across the Aviary consoles is
 * the point: a modal that is a hand-rolled `<div role="dialog">` here and a Dialog part everywhere
 * else is a fork in how every console's overlays are written, styled and tested. Ported from
 * `adonis-durable/packages/dashboard/src/app/ui/dialog.tsx`.
 *
 * The parts are re-exported for anything that needs the full composition; {@link Dialog} is the
 * shape this console actually uses (an optional title + close button, otherwise bare content —
 * the command palette supplies its own input/listbox as `children`).
 */
export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  className,
  initialFocus,
  ...popupProps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for a chrome-less panel (e.g. the command palette, which renders its own input as the
   *  first focusable element rather than a title bar). */
  title?: string;
  children: React.ReactNode;
  className?: string;
  /** Forwarded to `Popup`'s `initialFocus` — an element ref to focus on open. */
  initialFocus?: React.RefObject<HTMLElement | null>;
} & Omit<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup>,
  'className' | 'children' | 'initialFocus'
>) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Popup
          {...(initialFocus ? { initialFocus } : {})}
          {...popupProps}
          className={cn(
            'rise fixed left-1/2 top-[12vh] z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-panel-2 text-foreground shadow-2xl focus-visible:outline-none',
            className,
          )}
        >
          {title && (
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <DialogPrimitive.Title className="truncate text-[13px] font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogClose
                render={
                  <Button variant="quiet" size="icon" aria-label="Close">
                    <XIcon />
                  </Button>
                }
              />
            </div>
          )}
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogRoot>
  );
}
