'use client';

import { useEffect, useRef } from 'react';

// Отметка действия человека в рабочем месте (план M9, задача 4, решение 8; ASVS V7.3.1). Срок бездействия 30 минут
// продлевают только открытие страницы, нажатие и ввод: таймеры, обновление очереди и счётчиков отметку не шлют.
// Отметка уходит не чаще раза в минуту. Если сессия уже закрыта сроком, страница перезагружается и ведёт на вход с
// возвратом на эту же страницу; черновик ответа хранится отдельно от сессии и остаётся на месте.
// Серверное действие touch после router.refresh() приходит новым объектом: оно держится в useRef, а эффект без
// зависимостей, иначе перерисовка страницы сама слала бы отметку (независимая проверка M9, M1).

const STEP_MS = 60_000;

export function StaffActivity({ touch }: { touch: () => Promise<boolean> }) {
  const touchRef = useRef(touch);
  useEffect(() => {
    touchRef.current = touch;
  }, [touch]);
  useEffect(() => {
    let sentAt = 0;
    let busy = false;
    const send = () => {
      if (busy || Date.now() - sentAt < STEP_MS) return;
      busy = true;
      sentAt = Date.now();
      touchRef
        .current()
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
  }, []);
  return null;
}
