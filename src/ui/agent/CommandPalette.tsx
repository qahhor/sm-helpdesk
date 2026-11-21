'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/ui/components/dialog';
import { Input } from '@/ui/components/input';
import { cn } from '@/ui/cn';
import type { Command } from '@/ui/hotkeys/bus';

// Палитра команд (UX-A-02, UX-S-14): Ctrl+K и F2. Открыть обращение по номеру, сменить статус, назначить, вставить
// шаблон, перейти в раздел. Команды экрана приходят из шины, разделы и открытие по номеру добавляет оболочка.

export type PaletteLabels = { title: string; search: string; empty: string; close: string; list: string };

const TICKET = /^\s*(?:sup-)?(\d{1,12})\s*$/i;

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  openTicket,
  openTicketLabel,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
  openTicket: (number: number) => void;
  openTicketLabel: string;
  labels: PaletteLabels;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const found = useMemo(() => {
    const number = TICKET.exec(query)?.[1];
    const q = query.trim().toLocaleLowerCase('ru');
    const matching = q === '' ? commands : commands.filter((c) => `${c.group} ${c.label}`.toLocaleLowerCase('ru').includes(q));
    const byNumber: Command[] = number
      ? [{ id: `open-${number}`, group: '', label: openTicketLabel.replace('{number}', `SUP-${number}`), run: () => openTicket(Number(number)) }]
      : [];
    return [...byNumber, ...matching].slice(0, 50);
  }, [query, commands, openTicket, openTicketLabel]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
    setActive(0);
  };
  const runAt = (index: number) => {
    const command = found[index];
    if (!command) return;
    close();
    command.run();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent closeLabel={labels.close} aria-describedby={undefined}>
        <DialogTitle>{labels.title}</DialogTitle>
        <Input
          autoFocus
          role="combobox"
          aria-label={labels.search}
          aria-expanded={found.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={found[active] ? `palette-${found[active].id}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (found.length > 0) setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              runAt(active);
            }
          }}
        />
        {found.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul id="palette-list" role="listbox" aria-label={labels.list} className="flex max-h-96 flex-col overflow-y-auto">
            {found.map((command, index) => (
              <li
                key={command.id}
                id={`palette-${command.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  runAt(index);
                }}
                className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-control px-3 py-2 text-sm', index === active && 'bg-accent')}
              >
                <span>{command.label}</span>
                {command.group && <span className="text-xs text-muted-foreground">{command.group}</span>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
