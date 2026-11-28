'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';
import { TezMark } from '@/ui/brand/TezMark';
import { buttonVariants } from '@/ui/components/button';
import './globals.css';

// Ошибка в корневой раскладке (проверка интерфейса, U6): Next.js заменяет ею весь документ, раскладки и её строк
// уже нет. Язык берётся из адреса, тексты того же раздела common.error подгружаются отдельным файлом только здесь:
// в обычной работе сообщения в браузер не отправляются. Пока файл не пришёл, на экране только Тез.

type Texts = { title: string; text: string; retry: string; home: string };

const LOADERS: Record<Locale, () => Promise<{ default: { common: { error: Texts } } }>> = {
  ru: () => import('../../messages/ru.json'),
  uz: () => import('../../messages/uz.json'),
  en: () => import('../../messages/en.json'),
};

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [state, setState] = useState<{ locale: Locale; texts: Texts | null }>({ locale: DEFAULT_LOCALE, texts: null });
  useEffect(() => {
    const first = window.location.pathname.split('/')[1] ?? '';
    const locale = isLocale(first) ? first : DEFAULT_LOCALE;
    let active = true;
    LOADERS[locale]()
      .then((messages) => {
        if (active) setState({ locale, texts: messages.default.common.error });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const { locale, texts } = state;
  return (
    <html lang={locale}>
      <body>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 bg-background px-4 text-center text-foreground" aria-busy={texts ? undefined : true}>
          <TezMark size={96} />
          {texts && (
            <>
              <h1 className="text-lg font-semibold">{texts.title}</h1>
              <p className="text-secondary-foreground">{texts.text}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={reset} className={buttonVariants({ className: 'min-h-11' })}>
                  {texts.retry}
                </button>
                <a href={`/${locale}`} className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}>
                  {texts.home}
                </a>
              </div>
            </>
          )}
        </main>
      </body>
    </html>
  );
}
