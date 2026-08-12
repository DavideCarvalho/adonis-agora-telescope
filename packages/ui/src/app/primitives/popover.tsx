import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/** Base UI Popover. Ported from `adonis-durable/packages/dashboard/src/app/ui/popover.tsx`. */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup> {
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

/** Portal + Positioner + Popup collapsed into the one part a call site cares about. */
export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, side = 'bottom', align = 'end', sideOffset = 4, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-40"
      >
        <PopoverPrimitive.Popup
          ref={ref}
          className={cn(
            'rise w-72 overflow-hidden rounded-md border border-line bg-popover/95 text-zinc-300 shadow-xl backdrop-blur focus-visible:outline-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = 'PopoverContent';
