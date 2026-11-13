import type * as React from 'react';
import {
  Table as KitTable,
  TableBody as KitTableBody,
  TableCell as KitTableCell,
  TableHead as KitTableHead,
  TableHeader as KitTableHeader,
  TableRow as KitTableRow,
} from '../../agora-kit/ui/table';
import { cn } from './cn.js';

/**
 * The kit's shadcn `Table`, at this console's density: caps faint headers and 12.5px dim cells
 * (the kit `DataTable` look). Every table in the console — entries, exceptions, traces, N+1
 * hotspots, the extension panels — renders through these, so they all share one row rhythm.
 */
export function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'table'> & {
  /** Classes for the scroll container around the `<table>`. */
  containerClassName?: string;
}) {
  const table = <KitTable className={cn('text-[12.5px]', className)} {...props} />;
  return containerClassName ? <div className={containerClassName}>{table}</div> : table;
}

export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <KitTableHeader className={className} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <KitTableBody className={className} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <KitTableRow className={cn('border-border hover:bg-hover', className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <KitTableHead
      className={cn(
        'h-auto px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <KitTableCell
      className={cn('px-3 py-2 align-top whitespace-normal text-dim', className)}
      {...props}
    />
  );
}
