import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

// Кнопка на основе shadcn/ui. Высота 40 px, в кабинете клиента 44 px (класс h-control).
// Подпись кнопки: глагол, одно-два слова (правило голоса, ТЗ 8.13).
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-semibold outline-none ' +
    'transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'border border-input bg-card text-foreground hover:bg-card-soft',
        ghost: 'text-foreground hover:bg-accent',
        danger: 'border border-destructive bg-destructive-bg text-destructive-on-bg hover:bg-destructive-bg/80',
      },
      size: {
        default: 'h-control px-4',
        small: 'h-control-small px-3',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      type={asChild ? undefined : (type ?? 'button')}
      data-variant={variant ?? 'primary'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
