'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acceptHostMessage, resolveHostOrigin, sendToHost, type WidgetHints } from './protocol';
import {
  draftScopeOf,
  exchangeContextToken,
  platformOf,
  requestWithRenewal,
  type WidgetLabels,
  type WidgetNav,
  WidgetContext,
  type WidgetSession,
  type WidgetStatus,
  widgetFetch,
} from './session';

// Поставщик сессии страницы виджета во фрейме Smartup Web (план M6, задачи 4 и 5; решения 1, 8 и 16).
//
// 1. Адрес хозяина: location.ancestorOrigins или параметр ?origin= загрузчика, только из адресов встраивания сервера
//    (список приходит с сервера по ключу ?key=). Нет адреса: страница никому ничего не отправляет.
// 2. Хозяину уходит ready, в ответ приходит init с токеном контекста, подсказками, темой и языком.
// 3. Токен контекста меняется на токен виджета (POST /api/embed/session). Токен виджета только в памяти.
// 4. За минуту до истечения токена виджета, и при ответе 401, хозяину уходит need-token, в ответ приходит token.
//    Запрос с ответом 401 ждёт новый токен и повторяется один раз (решение 0061).
// Сообщения принимаются только из window.parent с адреса хозяина и только по схеме (src/ui/widget/protocol.ts).

const RENEW_BEFORE_SEC = 60;
// Сколько запрос после ответа 401 ждёт новый токен от хозяина (замечание M5 проверки M6).
const RENEW_WAIT_MS = 20_000;

export function EmbedSession({ allowed, locale, labels, children }: { allowed: string[]; locale: string; labels: WidgetLabels; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const key = search.get('key') ?? '';
  const originParam = search.get('origin');
  const [status, setStatus] = useState<WidgetStatus>('waiting');
  const [hints, setHints] = useState<WidgetHints>({});
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [platform, setPlatform] = useState<WidgetSession['platform']>(null);
  const token = useRef<string | null>(null);
  const hostOrigin = useRef<string | null>(null);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Запросы, которые после ответа 401 ждут следующий токен виджета.
  const waiters = useRef<((token: string | null) => void)[]>([]);

  const askForToken = useCallback(() => {
    sendToHost(window.parent, hostOrigin.current, { type: 'need-token' });
  }, []);

  /** Следующий токен виджета: просит у хозяина новый токен контекста и ждёт обмена. Не дождался: null. */
  const nextToken = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          waiters.current = waiters.current.filter((waiter) => waiter !== done);
          resolve(null);
        }, RENEW_WAIT_MS);
        const done = (value: string | null) => {
          clearTimeout(timer);
          resolve(value);
        };
        // Несколько запросов с ответом 401 сразу: хозяина просят один раз.
        if (waiters.current.push(done) === 1) askForToken();
      }),
    [askForToken],
  );

  const exchange = useCallback(
    async (contextToken: string) => {
      const result = await exchangeContextToken(contextToken, token.current);
      const settle = (value: string | null) => {
        for (const resolve of waiters.current.splice(0)) resolve(value);
      };
      if ('failed' in result) {
        // Продление не удалось, а прежний токен ещё действует: работа продолжается до его срока.
        if (!token.current) setStatus(result.failed);
        settle(null);
        return;
      }
      token.current = result.token;
      settle(result.token);
      setDraftScope(draftScopeOf(result.token));
      setPlatform(platformOf(result.token));
      setStatus('ready');
      if (renewTimer.current) clearTimeout(renewTimer.current);
      renewTimer.current = setTimeout(askForToken, Math.max(5, result.expiresIn - RENEW_BEFORE_SEC) * 1000);
    },
    [askForToken],
  );

  useEffect(() => {
    hostOrigin.current = resolveHostOrigin({
      allowed,
      ancestorOrigins: (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins as unknown as ArrayLike<string> | undefined,
      param: originParam,
      framed: window.parent !== window,
    });
    if (!hostOrigin.current) {
      setStatus('refused');
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const message = acceptHostMessage(event, { parent: window.parent, hostOrigin: hostOrigin.current });
      if (!message) return;
      if (message.type === 'init') {
        setHints(message.hints);
        if (message.theme) document.documentElement.classList.toggle('dark', message.theme === 'dark');
        void exchange(message.token);
      } else if (message.type === 'token') void exchange(message.token);
      else setHints(message.hints);
    };
    // Esc внутри фрейма закрывает панель: событие клавиатуры фрейма до страницы хозяина не доходит.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') sendToHost(window.parent, hostOrigin.current, { type: 'close' });
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKey);
    sendToHost(window.parent, hostOrigin.current, { type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('keydown', onKey);
      if (renewTimer.current) clearTimeout(renewTimer.current);
    };
    // Подключение один раз: адрес хозяина и список не меняются за жизнь фрейма.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nav = useMemo<WidgetNav>(() => {
    // Ключ встраивания и адрес хозяина остаются в адресе при каждом переходе внутри фрейма (решение 0058).
    const query = `?key=${encodeURIComponent(key)}${originParam ? `&origin=${encodeURIComponent(originParam)}` : ''}`;
    const go = (path: string) => {
      const target = `/${locale}/embed/${path}${query}`;
      if (pathname !== target.split('?')[0]) router.push(target);
    };
    return {
      report: () => go('report'),
      tickets: () => go('tickets'),
      ticket: (number) => go(`tickets/${number}`),
      portalHref: (path) => `/${locale}${path}`,
    };
  }, [key, originParam, locale, pathname, router]);

  const session = useMemo<WidgetSession>(
    () => ({
      status,
      platform,
      locale,
      draftScope,
      hints,
      labels,
      // Ответ 401 (токен истёк, пока компьютер спал): новый токен у хозяина и один повтор (решение 0061).
      request: (path, init) => requestWithRenewal((value) => widgetFetch(value, path, init), token.current, nextToken),
      authHeaders: (): Record<string, string> => (token.current ? { Authorization: `Bearer ${token.current}` } : {}),
      ticketCreated: (number) => sendToHost(window.parent, hostOrigin.current, { type: 'ticket-created', number }),
      close: () => sendToHost(window.parent, hostOrigin.current, { type: 'close' }),
      nav,
    }),
    [status, platform, locale, draftScope, hints, labels, nextToken, nav],
  );

  return <WidgetContext.Provider value={session}>{children}</WidgetContext.Provider>;
}
