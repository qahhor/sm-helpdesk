'use client';

import { useEffect, useRef } from 'react';

type TurnstileApi = { reset(container: HTMLElement): void };

/**
 * Сбрасывает виджеты проверки "не робот" после ответа формы. Токен виджета одноразовый: без сброса
 * повторная попытка (неверный пароль, другой адрес) ушла бы со старым токеном и не прошла проверку.
 * resetKey меняется с каждым ответом: состояние формы или одноразовый код страницы. Первый показ не сбрасывает.
 */
export function BotCheckRefresh({ resetKey }: { resetKey: unknown }) {
  const shown = useRef(false);
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      return;
    }
    const turnstile = (window as typeof window & { turnstile?: TurnstileApi }).turnstile;
    if (!turnstile) return;
    for (const container of document.querySelectorAll<HTMLElement>('.cf-turnstile')) {
      try {
        turnstile.reset(container);
      } catch {
        // Виджет в этом месте ещё не создан: сбрасывать нечего.
      }
    }
  }, [resetKey]);
  return null;
}
