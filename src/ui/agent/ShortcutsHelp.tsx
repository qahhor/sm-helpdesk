'use client';

import { Dialog, DialogContent, DialogTitle } from '@/ui/components/dialog';

// Справка по клавишам рабочего места ("?"): список берётся из реестра, подписи из messages/*.json.

export function ShortcutsHelp({
  open,
  onOpenChange,
  items,
  title,
  close,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: { keys: string; label: string }[];
  title: string;
  close: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={close} aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {items.map((item) => (
            <div key={item.keys} className="contents">
              <dt>
                <kbd className="rounded-control border border-border bg-card-soft px-2 py-1 font-mono text-xs">{item.keys}</kbd>
              </dt>
              <dd>{item.label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
