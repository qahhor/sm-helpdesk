'use client';

import { createContext, type ReactNode, useContext } from 'react';
import { buttonVariants } from '@/ui/components/button';
import { EmptyState } from '@/ui/components/EmptyState';

// Экран ошибки страницы (проверка интерфейса, U6). Граница ошибок Next.js (error.tsx) работает в браузере и не
// получает параметров от сервера, а тексты портала переводятся на сервере. Поэтому раскладка кладёт готовые строки
// в контекст, а экран ошибки берёт их оттуда. Причина ошибки пользователю не показывается: её пишет журнал сервера.

export type ErrorTexts = { title: string; text: string; retry: string; home: string; homeHref: string };

const Context = createContext<ErrorTexts | null>(null);

/** Строки экрана ошибки для страниц под этой раскладкой. */
export function ErrorTextsProvider({ value, children }: { value: ErrorTexts; children: ReactNode }) {
  return <Context value={value}>{children}</Context>;
}

/** Экран ошибки внутри оболочки: что случилось простыми словами, "Повторить" и путь на главную (голос 8.13). */
export function ErrorScreen({ reset }: { reset: () => void }) {
  const texts = useContext(Context);
  // Раскладка не успела отрисоваться (ошибка в ней самой): строк нет, показывать нечего. Такую ошибку берёт global-error.
  if (!texts) return null;
  return (
    <div role="alert" data-testid="error-screen">
      <EmptyState
        withTez
        title={texts.title}
        text={texts.text}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={reset} className={buttonVariants({ className: 'min-h-11' })}>
              {texts.retry}
            </button>
            {/* Обычная ссылка с полной загрузкой: после ошибки состояние приложения в браузере ненадёжно. */}
            <a href={texts.homeHref} className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}>
              {texts.home}
            </a>
          </div>
        }
      />
    </div>
  );
}
