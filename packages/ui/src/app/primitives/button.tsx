import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * The console's button, as one variant table instead of hand-tuned class strings — ported from
 * `adonis-durable/packages/dashboard/src/app/ui/button.tsx`, the ecosystem's reference
 * implementation of this primitive on Base UI.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
  {
    variants: {
      variant: {
        /** Neutral bordered action — the default. */
        outline: 'border-line text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
        /** Borderless, for close/clear affordances. */
        ghost: 'border-transparent text-zinc-500 hover:text-zinc-200',
        /** Bordered icon well (panel close buttons). */
        quiet: 'border-line text-zinc-500 hover:text-zinc-200',
        /** The console accent — the primary action. */
        brand: 'border-brand/30 bg-brand/10 text-brand hover:bg-brand/20',
        /** Needs-attention amber. */
        warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
        /** Operational, non-destructive. */
        info: 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20',
        /** Destructive action. */
        danger: 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20',
        /** A selectable chip in a row of chips. */
        chip: 'border-line bg-zinc-800/40 text-zinc-400 hover:border-zinc-500',
        /** The active state of a chip / tab-like toggle. */
        'chip-active': 'border-brand/40 bg-brand/15 text-brand',
      },
      size: {
        /** Header actions. */
        sm: 'px-3 py-1.5 text-xs uppercase tracking-wide',
        /** Dense inline chips and mono micro-actions. */
        xs: 'px-1.5 py-0.5 text-[10px]',
        /** Filter chips / list-level actions. */
        chip: 'px-2.5 py-1 text-xs',
        /** Square icon well. */
        icon: 'h-8 w-8 shrink-0 p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/**
 * A plain `<button>`. Composition goes the other way round with Base UI: a part renders THIS
 * (`<Dialog.Close render={<Button …/>} />`), merging its props in, so there is no `asChild` here.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      // Never submit a form by accident — every button in this console is an action.
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
