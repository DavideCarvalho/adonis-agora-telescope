import { forwardRef } from 'react';
import { XIcon } from '../icons.js';
import { Button } from './button.js';
import { cn } from './cn.js';

/** The bare field. Ported from `adonis-durable/packages/dashboard/src/app/ui/input.tsx`. */
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export interface InputFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Leading glyph — decorative, so it is hidden from assistive tech. */
  glyph?: React.ReactNode;
  /** Renders a clear button while the field is non-empty. */
  onClear?: () => void;
  clearLabel?: string;
  containerClassName?: string;
}

/** A bordered filter row: glyph · input · clear. Focus-within moves the ring to the whole box. */
export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(
  (
    { glyph, onClear, clearLabel = 'clear', containerClassName, value, className, ...props },
    ref,
  ) => (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 transition-colors focus-within:ring-1 focus-within:ring-ring',
        containerClassName,
      )}
    >
      {glyph !== undefined && (
        <span className="shrink-0 text-muted-foreground" aria-hidden>
          {glyph}
        </span>
      )}
      <Input
        ref={ref}
        value={value}
        className={cn('border-0 bg-transparent px-0 focus-visible:ring-0', className)}
        {...props}
      />
      {onClear && value ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          title={clearLabel}
          aria-label={clearLabel}
          className="h-4 w-4"
        >
          <XIcon width={12} height={12} />
        </Button>
      ) : null}
    </div>
  ),
);
InputField.displayName = 'InputField';
