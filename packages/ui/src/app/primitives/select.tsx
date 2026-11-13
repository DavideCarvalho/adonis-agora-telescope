import type * as React from 'react';
import {
  SelectContent as KitSelectContent,
  SelectItem as KitSelectItem,
  SelectTrigger as KitSelectTrigger,
  Select,
  SelectGroup,
  SelectValue,
} from '../../agora-kit/ui/select';
import { cn } from './cn.js';

/**
 * The kit's shadcn `Select` (Base UI), at toolbar size: a 30px trigger with a 12px label, and a
 * popup that opens below the trigger instead of over it.
 */
export { Select, SelectGroup, SelectValue };

export function SelectTrigger({
  className,
  ...props
}: React.ComponentProps<typeof KitSelectTrigger>) {
  return (
    <KitSelectTrigger
      size="sm"
      className={cn('h-[30px] bg-panel-2 text-xs text-fg-2 data-[size=sm]:h-[30px]', className)}
      {...props}
    />
  );
}

export function SelectContent({
  align = 'start',
  ...props
}: React.ComponentProps<typeof KitSelectContent>) {
  return <KitSelectContent align={align} alignItemWithTrigger={false} {...props} />;
}

export function SelectItem({ className, ...props }: React.ComponentProps<typeof KitSelectItem>) {
  return <KitSelectItem className={cn('text-xs', className)} {...props} />;
}
