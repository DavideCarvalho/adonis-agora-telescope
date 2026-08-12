import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Table`, retuned to the Aviary tokens. Ported byte-for-byte from
 * `@dudousxd/nestjs-telescope-ui`'s `src/react/ui/table.tsx` (this console's NestJS sibling).
 *
 * Pure markup + classes — no Base UI, so it is safe anywhere. Dense and monospaced-numeric by
 * default, matching every table in this dashboard (entries, exceptions, traces, N+1 hotspots).
 */
export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Classes for the scroll container that wraps the `<table>` (replaces `.table-wrap`). */
  containerClassName?: string;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    <div className={cn('w-full overflow-x-auto', containerClassName)}>
      <table ref={ref} className={cn('w-full border-collapse text-xs', className)} {...props} />
    </div>
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      ref={ref}
      className={cn(
        'border-b border-line text-left text-[10px] uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn('divide-y divide-line-soft', className)} {...props} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return <tr ref={ref} className={cn('transition-colors', className)} {...props} />;
  },
);

export const TableHead = forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(function TableHead({ className, ...props }, ref) {
  return <th ref={ref} className={cn('px-3 py-2 font-normal', className)} {...props} />;
});

export const TableCell = forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(function TableCell({ className, ...props }, ref) {
  return <td ref={ref} className={cn('px-3 py-2 align-top', className)} {...props} />;
});
