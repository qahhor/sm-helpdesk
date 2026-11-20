'use client';

import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

// Нижний лист на основе shadcn/ui (Radix Dialog). На телефоне меню и всплывающие окна
// открываются листом снизу (поставка Smartup Web, слой телефона).

export const Sheet = Primitive.Root;
export const SheetTrigger = Primitive.Trigger;
export const SheetClose = Primitive.Close;

export function SheetContent({ className, children, closeLabel, ...props }: ComponentProps<typeof Primitive.Content> & { closeLabel: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
      <Primitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-4 overflow-y-auto rounded-t-card border-t border-border bg-card p-4 text-card-foreground outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          aria-label={closeLabel}
          className="absolute end-3 top-3 inline-flex size-control items-center justify-center rounded-control outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-5" aria-hidden />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn('pe-12 text-lg font-semibold', className)} {...props} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn('text-secondary-foreground', className)} {...props} />;
}
