import createMiddleware from 'next-intl/middleware';
import { type NextRequest, NextResponse } from 'next/server';
import { LOCALE_COOKIE } from '@/i18n/locales';
import { localizedPath, resolveLocale } from '@/i18n/resolve-locale';
import { routing } from '@/i18n/routing';
import { sessionCookieRefresh } from '@/modules/hdu/api/session-cookie';
import { buildCsp, createNonce, CSP_HEADER, storageOriginOf } from '@/security/csp';
import { EMBED_KEY_PARAM, embedAncestors, isEmbedPath, isWidgetPath } from '@/security/embed-frame';
import { isPublicPath } from '@/security/public-paths';

// Выполняется перед каждым запросом страницы (в Next.js 16 файл называется proxy, раньше middleware).
// 1. Адрес без языка или с неподдерживаемым языком перенаправляется на язык посетителя (FR-I18N-06).
// 2. Для страницы создаётся одноразовый код и политика CSP (ТЗ 14.4).
// 3. Приложению передаётся путь запроса: по нему страница входа знает, куда вернуть человека.
// 4. На запросе страницы кука сессии ставится заново на 30 дней (FR-ID-10). В базу прокси не ходит:
//    действительна ли сессия, решает только база. На страницах открытой зоны кука не трогается (ТЗ 18.10).
// 5. Страницы виджета /{язык}/embed встраиваются только адресами сервера Smartup, чей ключ встраивания стоит в адресе
//    (план M6, задача 3, решение 6); остальные страницы нигде. Страницы виджета и мобильного приложения (/{язык}/m)
//    сессию портала не используют: прокси не продлевает её куку и не передаёт куки странице (решение 1 плана M6).

const withLocale = createMiddleware(routing);

/** Адрес с испорченной последовательностью %XX: Next.js отвечает на него ошибкой 500 ещё до страницы. */
function isMalformedPath(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

const isLocalPortal = (hubUrl: string | undefined): boolean => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(hubUrl ?? '').hostname);
  } catch {
    return false;
  }
};

/**
 * Политика страницы. Страница виджета с ключом встраивания: frame-ancestors адресами этого сервера, иначе 'none'.
 * Адрес, который политика не принимает (испорченная строка реестра), запрещает встраивание, а не ломает страницу.
 */
async function pageCsp(request: NextRequest, nonce: string): Promise<string> {
  const base = { nonce, dev: process.env.NODE_ENV === 'development', storageOrigin: storageOriginOf(process.env) };
  if (!isEmbedPath(request.nextUrl.pathname)) return buildCsp(base);
  const frameAncestors = await embedAncestors(request.nextUrl.searchParams.get(EMBED_KEY_PARAM));
  try {
    return buildCsp({ ...base, frameAncestors, allowLoopbackAncestors: isLocalPortal(process.env.HUB_URL) });
  } catch {
    return buildCsp(base);
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const target = localizedPath(request.nextUrl.pathname, () =>
    resolveLocale({
      userPref: request.cookies.get(LOCALE_COOKIE)?.value,
      acceptLanguage: request.headers.get('accept-language'),
    }),
  );
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    return NextResponse.redirect(url, 307);
  }

  // Испорченный адрес: Next.js разбирает его ещё до страницы и отвечает ошибкой 500, внутренняя перезапись
  // не помогает. Перенаправляем на страницу "не найдено" того же языка (код 404). Адрес без языка к этому
  // месту уже перенаправлен на адрес с языком.
  if (isMalformedPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${request.nextUrl.pathname.split('/')[1]}/not-found`;
    url.search = '';
    return NextResponse.redirect(url, 307);
  }

  const nonce = createNonce();
  const csp = await pageCsp(request, nonce);
  const widget = isWidgetPath(request.nextUrl.pathname);
  // Страница виджета не видит сессию портала, даже если кука есть в браузере (раздел "На что смотреть", пункт 6).
  if (widget) request.headers.delete('cookie');

  // Приложение получает код только от прокси: значения, присланные клиентом, затираются.
  // Next.js берёт код для своих скриптов из заголовка политики в запросе.
  request.headers.set('x-nonce', nonce);
  // Путь запроса для возврата после входа. Страницы сервера адреса запроса не видят, поэтому его передаёт прокси.
  request.headers.set('x-hub-path', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  request.headers.delete('content-security-policy');
  request.headers.set(CSP_HEADER.toLowerCase(), csp);

  const response = withLocale(request);
  response.headers.set(CSP_HEADER, csp);
  // Только чтение страницы: ответ на серверное действие (POST) может как раз удалять куку при выходе.
  if (request.method === 'GET' && !isPublicPath(request.nextUrl.pathname) && !widget) {
    const refresh = sessionCookieRefresh(request.headers.get('cookie'));
    if (refresh) response.headers.append('set-cookie', refresh);
  }
  return response;
}

export const config = {
  // Страницы портала. Не затрагиваются обработчики /api/, служебные адреса /_next/ и файлы интерфейса
  // (по списку расширений). Адрес с точкой в имени (/ru/users/john.doe) это страница, он идёт через прокси.
  matcher: ['/((?!api/|_next/|.*\\.(?:ico|png|jpg|jpeg|gif|webp|svg|woff2|css|js|map|txt|xml|json|webmanifest)$).*)'],
};
