'use client';

import { useCallback, useMemo } from 'react';
import { type Command, useCommands, useHotkey } from '@/ui/hotkeys/bus';
import { assignAction, statusAction, takeAction } from './actions';
import { COMPOSER_FOCUS, COMPOSER_INSERT } from './Composer';

// Клавиши и команды палитры на странице обращения (UX-A-02, UX-A-17; план M3, задача 14): T взять себе, R ответ,
// N заметка, S отложить; в палитре взять, назначить на себя, сменить статус, вставить шаблон. Действия идут теми же
// серверными действиями, что и кнопки: права и переходы проверяет сервис.

export type TicketKeysLabels = { group: string; templates: string; take: string; assignMe: string; status: string; template: string };

type Props = {
  number: number;
  me: string;
  canWrite: boolean;
  canTake: boolean;
  transitions: { to: string; label: string }[];
  templates: { shortcut: string; title: string; text: string; fallback: boolean }[];
  labels: TicketKeysLabels;
};

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

export function TicketKeys({ number, me, canWrite, canTake, transitions, templates, labels }: Props) {
  const take = useCallback(() => void takeAction(form({ number: String(number) })), [number]);
  const focusComposer = (mode: 'reply' | 'note') => () => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS, { detail: mode }));
  useHotkey('ticket.take', take, canWrite && canTake);
  useHotkey('reply.focus', useMemo(() => focusComposer('reply'), []), canWrite);
  useHotkey('note.focus', useMemo(() => focusComposer('note'), []), canWrite);
  useHotkey(
    'ticket.snooze',
    useCallback(() => document.querySelector<HTMLElement>('[data-snooze-first]')?.focus(), []),
    canWrite,
  );

  const commands = useMemo<Command[]>(() => {
    if (!canWrite) return [];
    const list: Command[] = [];
    if (canTake) list.push({ id: 'take', group: labels.group, label: labels.take, run: take });
    list.push({ id: 'assign-me', group: labels.group, label: labels.assignMe, run: () => void assignAction(form({ number: String(number), assigneeId: me })) });
    for (const t of transitions)
      list.push({
        id: `status-${t.to}`,
        group: labels.group,
        label: labels.status.replace('{status}', t.label),
        // "Решено" требует итога: палитра открывает поле итога в панели, остальное меняется сразу.
        run: () => {
          if (t.to !== 'resolved') return void statusAction(form({ number: String(number), to: t.to }));
          const select = document.querySelector<HTMLSelectElement>('#ctl-status');
          if (select) select.value = 'resolved';
          document.querySelector<HTMLElement>('#ctl-resolution')?.focus();
        },
      });
    for (const tpl of templates)
      list.push({
        id: `template-${tpl.shortcut}`,
        group: labels.templates,
        label: labels.template.replace('{code}', tpl.shortcut).replace('{title}', tpl.title),
        run: () => window.dispatchEvent(new CustomEvent(COMPOSER_INSERT, { detail: { text: tpl.text, fallback: tpl.fallback } })),
      });
    return list;
  }, [canWrite, canTake, labels, take, number, me, transitions, templates]);
  useCommands('ticket', commands);
  return null;
}
