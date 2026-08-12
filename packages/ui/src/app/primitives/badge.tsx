import { type VariantProps, cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * A non-interactive label chip: tags, `trace:`, entry-type badges, status pills. Ported from
 * `adonis-durable/packages/dashboard/src/app/ui/badge.tsx`.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded border px-1.5 text-[10px] leading-relaxed',
  {
    variants: {
      variant: {
        outline: 'border-line bg-zinc-800/40 text-zinc-400',
        good: 'border-good/40 bg-good/10 text-good',
        warn: 'border-warn/40 bg-warn/10 text-warn',
        bad: 'border-bad/40 bg-bad/10 text-bad',
        brand: 'border-brand/30 bg-brand/10 text-brand',
        /** A type/status badge — colour comes from the caller's inline `style` (per-type hue). */
        dot: 'border-transparent bg-transparent px-0',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
