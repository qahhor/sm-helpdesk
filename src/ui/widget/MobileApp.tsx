'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReportView } from './ReportView';
import { draftScopeOf, exchangeContextToken, platformOf, type WidgetLabels, type WidgetNav, WidgetContext, type WidgetSession, type WidgetStatus, widgetFetch } from './session';
import { TicketView } from './TicketView';
import { TicketsView } from './TicketsView';
import { WidgetFrame } from './WidgetFrame';

// Страница для мобильного приложения /{язык}/m/report#ctx=<токен> (план M6, задача 7; FR-WG-08, ТЗ 11.9).
//
// Приложение открывает страницу во встроенном браузере с токеном контекста после #: фрагмент не уходит на сервер и
// в журнал. До первого запроса страница убирает его из адресной строки и записи истории (history.replaceState),
// затем меняет токен контекста на токен виджета, который живёт только в памяти. Переход к "Мои обращения" и к
// обращению идёт сменой экрана без перезагрузки. Без токена, после перезагрузки и по истечении токена страница
// просит открыть её заново из приложения: продлить токен некому, хозяина с getContextToken здесь нет.

type View = { name: 'report' } | { name: 'tickets' } | { name: 'ticket'; number: number };

const CTX = /^#ctx=([A-Za-z0-9_.-]{1,8192})$/;

/** Токен контекста из фрагмента адреса и сразу адрес без фрагмента. Нет токена: null. */
function takeContextToken(): string | null {
  const match = CTX.exec(window.location.hash);
  if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return match?.[1] ?? null;
}

export function MobileApp({ locale, labels, accept, maxFiles }: { locale: string; labels: WidgetLabels; accept: string; maxFiles: number }) {
  const [status, setStatus] = useState<WidgetStatus>('waiting');
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [platform, setPlatform] = useState<WidgetSession['platform']>(null);
  const [view, setView] = useState<View>({ name: 'report' });
  const token = useRef<string | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (contextToken: string | null) => {
    if (!contextToken) {
      if (!token.current) setStatus('expired');
      return;
    }
    const result = await exchangeContextToken(contextToken, token.current);
    if ('failed' in result) {
      token.current = null;
      return setStatus(result.failed);
    }
    token.current = result.token;
    setDraftScope(draftScopeOf(result.token));
    setPlatform(platformOf(result.token));
    setStatus('ready');
    if (expiry.current) clearTimeout(expiry.current);
    expiry.current = setTimeout(() => {
      token.current = null;
      setStatus('expired');
    }, result.expiresIn * 1000);
  }, []);

  useEffect(() => {
    void start(takeContextToken());
    // Приложение может открыть ту же страницу с новым токеном: смена фрагмента без перезагрузки.
    const onHash = () => {
      const next = takeContextToken();
      if (next) void start(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      if (expiry.current) clearTimeout(expiry.current);
    };
  }, [start]);

  const nav = useMemo<WidgetNav>(
    () => ({
      report: () => setView({ name: 'report' }),
      tickets: () => setView({ name: 'tickets' }),
      ticket: (number) => setView({ name: 'ticket', number }),
      portalHref: (path) => `/${locale}${path}`,
    }),
    [locale],
  );

  const session = useMemo<WidgetSession>(
    () => ({
      status,
      platform,
      locale,
      draftScope,
      hints: {},
      // Отказ и истёкший сеанс на этой странице лечатся одним: открыть её заново из приложения.
      labels: { ...labels, 'panel.expired': labels['mobile.reopen'] ?? '', 'panel.refused': labels['mobile.reopen'] ?? '' },
      async request(path, init) {
        const response = await widgetFetch(token.current, path, init);
        if (response.status === 401) {
          token.current = null;
          setStatus('expired');
        }
        return response;
      },
      authHeaders: (): Record<string, string> => (token.current ? { Authorization: `Bearer ${token.current}` } : {}),
      ticketCreated: () => undefined,
      close: null,
      nav,
    }),
    [status, platform, locale, draftScope, labels, nav],
  );

  return (
    <WidgetContext.Provider value={session}>
      <WidgetFrame active={view.name === 'report' ? 'report' : 'tickets'}>
        {view.name === 'report' && <ReportView accept={accept} maxFiles={maxFiles} />}
        {view.name === 'tickets' && <TicketsView />}
        {view.name === 'ticket' && <TicketView key={view.number} number={view.number} accept={accept} maxFiles={maxFiles} />}
      </WidgetFrame>
    </WidgetContext.Provider>
  );
}
