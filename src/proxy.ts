import createMiddleware from 'next-intl/middleware';
import { type NextRequest, NextResponse } from 'next/server';
import { LOCALE_COOKIE } from '@/i18n/locales';
import { localizedPath, resolveLocale } from '@/i18n/resolve-locale';
import { routing } from '@/i18n/routing';
import { buildCsp, createNonce, CSP_HEADER } from '@/security/csp';

// Выполняется перед каждым запросом страницы (в Next.js 16 файл называется proxy, раньше middleware).
// 1. Адрес без языка или с неподдерживаемым языком перенаправляется на язык посетителя (FR-I18N-06).
// 2. Для страницы создаётся одноразовый код и политика CSP (ТЗ 14.4).

const withLocale = createMiddleware(routing);

export function proxy(request: NextRequest): NextResponse {
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

  const nonce = createNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === 'development' });

  // Приложение получает код только от прокси: значения, присланные клиентом, затираются.
  // Next.js берёт код для своих скриптов из заголовка политики в запросе.
  request.headers.set('x-nonce', nonce);
  request.headers.delete('content-security-policy');
  request.headers.set(CSP_HEADER.toLowerCase(), csp);

  const response = withLocale(request);
  response.headers.set(CSP_HEADER, csp);
  return response;
}

export const config = {
  // Страницы портала. Обработчики /api, служебные адреса Next.js и файлы с расширением не затрагиваются.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
