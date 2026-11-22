'use client';

import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

// Окно поверх страницы на основе shadcn/ui (Radix Dialog): фокус внутри окна, Esc закрывает, фон затемнён.
// На рабочем месте: передача на вторую линию и возврат на первую (ТЗ 8.12).

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = ({ className, ...props }: ComponentProps<typeof Primitive.Title>) => (
  <Primitive.Title className={cn('text-lg font-semibold', className)} {...props} />
);
export const DialogDescription = ({ className, ...props }: ComponentProps<typeof Primitive.Description>) => (
  <Primitive.Description className={cn('text-sm text-secondary-foreground', className)} {...props} />
);

export function DialogContent({ className, children, closeLabel, ...props }: ComponentProps<typeof Primitive.Content> & { closeLabel: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
      <Primitive.Content
        className={cn(
          'fixed inset-x-4 top-8 z-50 mx-auto flex max-h-sheet max-w-2xl flex-col gap-4 overflow-y-auto rounded-card border border-border bg-card p-6 text-card-foreground outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          aria-label={closeLabel}
          className="absolute end-3 top-3 inline-flex size-control items-center justify-center rounded-control outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
