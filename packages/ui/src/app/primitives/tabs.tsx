import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Base UI Tabs, styled as this console's segmented control (replaces the hand-rolled
 * `.segmented`/`aria-selected` buttons). Ported from
 * `adonis-durable/packages/dashboard/src/app/ui/tabs.tsx`.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center gap-0.5 rounded-md border border-line p-0.5',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTab = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Tab>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Tab
    ref={ref}
    className={cn(
      'cursor-pointer rounded px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[selected]:bg-brand data-[selected]:text-brand-foreground',
      className,
    )}
    {...props}
  />
));
TabsTab.displayName = 'TabsTab';

export const TabsPanel = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Panel>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Panel
    ref={ref}
    className={cn('focus-visible:outline-none', className)}
    {...props}
  />
));
TabsPanel.displayName = 'TabsPanel';
