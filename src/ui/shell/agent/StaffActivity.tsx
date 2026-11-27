'use client';

import { useEffect } from 'react';

// Отметка действия человека в рабочем месте (план M9, задача 4, решение 8; ASVS V7.3.1). Срок бездействия 30 минут
// продлевают только открытие страницы, нажатие и ввод: таймеры, обновление очереди и счётчиков отметку не шлют.
// Отметка уходит не чаще раза в минуту. Если сессия уже закрыта сроком, страница перезагружается и ведёт на вход с
// возвратом на эту же страницу; черновик ответа хранится отдельно от сессии и остаётся на месте.

const STEP_MS = 60_000;

export function StaffActivity({ touch }: { touch: () => Promise<boolean> }) {
  useEffect(() => {
    let sentAt = 0;
    let busy = false;
    const send = () => {
      if (busy || Date.now() - sentAt < STEP_MS) return;
      busy = true;
      sentAt = Date.now();
      touch()
        .then((alive) => {
          if (!alive) window.location.reload();
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    send();
    window.addEventListener('pointerdown', send, { passive: true });
    window.addEventListener('keydown', send);
    return () => {
      window.removeEventListener('pointerdown', send);
      window.removeEventListener('keydown', send);
    };
  }, [touch]);
  return null;
}
