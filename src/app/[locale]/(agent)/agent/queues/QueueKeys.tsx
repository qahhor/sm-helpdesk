'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useHotkey } from '@/ui/hotkeys/bus';

// Переход по очереди с клавиатуры (UX-A-01, UX-A-17): стрелки двигают фокус по строкам; на широком экране,
// где рядом со списком видно обращение, стрелка ещё и открывает его рядом. F7 обновляет список (UX-S-14).

const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-row-link]')];
/** Панель "рядом" видна только на широком экране: её показывает разметка, а не число в коде. */
const sideBySide = () => document.querySelector<HTMLElement>('[data-preview-pane]')?.offsetParent != null;

export function QueueKeys() {
  const router = useRouter();
  const move = useCallback(
    (step: 1 | -1) => {
      const list = rows();
      if (list.length === 0) return;
      const at = list.findIndex((link) => link === document.activeElement || link.dataset.open !== undefined);
      const next = list[at === -1 ? (step === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + step))];
      if (!next) return;
      next.focus();
      if (sideBySide() && next.dataset.preview) router.replace(next.dataset.preview, { scroll: false });
    },
    [router],
  );
  useHotkey('list.next', useCallback(() => move(1), [move]));
  useHotkey('list.prev', useCallback(() => move(-1), [move]));
  useHotkey('table.refresh', useCallback(() => router.refresh(), [router]));
  return null;
}
