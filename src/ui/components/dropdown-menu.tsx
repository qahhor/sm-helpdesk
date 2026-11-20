'use client';

import { Check } from 'lucide-react';
import { DropdownMenu as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

// Выпадающее меню на основе shadcn/ui (Radix). Размеры и цвета только из токенов,
// направления только логические: меню одинаково работает при письме слева направо и справа налево.

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-control border border-border bg-popover p-1 text-popover-foreground shadow-card',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

const itemClass =
  'relative flex min-h-control cursor-default select-none items-center gap-2 rounded-control px-3 text-base outline-none ' +
  'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(itemClass, 'pe-9', className)} {...props}>
      {children}
      <span className="absolute end-3 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check className="size-4" aria-hidden />
        </Primitive.ItemIndicator>
      </span>
    </Primitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-3 py-2 text-xs font-semibold text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
