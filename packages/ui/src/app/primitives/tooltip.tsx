import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { ReactElement } from 'react';
import { cn } from './cn.js';

/** Wraps the whole app once. Ported from `adonis-durable/packages/dashboard/src/app/ui/tooltip.tsx`. */
export function TooltipProvider({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delay={150} closeDelay={80} {...props}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

const POPUP_CLASS =
  'z-50 max-w-[280px] whitespace-pre-line rounded-md border border-line bg-popover/95 px-2 py-1 text-left text-[10px] leading-relaxed text-zinc-300 shadow-xl backdrop-blur';

/** The console's tooltip: portalled content, collision-aware placement, `role="tooltip"`, dismissal
 *  on Escape — everything the previous `title="…"` attribute didn't give us. */
export function Tooltip({
  label,
  side = 'bottom',
  align = 'center',
  children,
}: {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** The trigger element — Base UI renders IT, rather than wrapping it in another box. */
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={4} collisionPadding={8}>
          <TooltipPrimitive.Popup className={cn(POPUP_CLASS)}>{label}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipRoot>
  );
}
