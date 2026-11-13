import type * as React from 'react';
import { XIcon } from '../../agora-kit/icons';
import { Input as KitInput } from '../../agora-kit/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../../agora-kit/ui/input-group';
import { cn } from './cn.js';

/** The kit's shadcn `Input`, at toolbar size. */
export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <KitInput className={cn('h-[30px] text-xs md:text-xs', className)} {...props} />;
}

export interface InputFieldProps extends React.ComponentProps<'input'> {
  /** Leading glyph — decorative, so it is hidden from assistive tech. */
  glyph?: React.ReactNode;
  /** Renders a clear button while the field is non-empty. */
  onClear?: () => void;
  clearLabel?: string;
  containerClassName?: string;
}

/** A filter field (shadcn `InputGroup`): glyph · input · clear. */
export function InputField({
  glyph,
  onClear,
  clearLabel = 'clear',
  containerClassName,
  value,
  className,
  ...props
}: InputFieldProps) {
  return (
    <InputGroup className={cn('h-[30px]', containerClassName)}>
      {glyph !== undefined && (
        <InputGroupAddon aria-hidden className="text-faint">
          {glyph}
        </InputGroupAddon>
      )}
      <InputGroupInput value={value} className={cn('text-xs md:text-xs', className)} {...props} />
      {onClear && value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            onClick={onClear}
            title={clearLabel}
            aria-label={clearLabel}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
