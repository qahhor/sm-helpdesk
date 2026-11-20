import createMiddleware from 'next-intl/middleware';
import { type NextRequest, NextResponse } from 'next/server';
import { LOCALE_COOKIE } from '@/i18n/locales';
import { localizedPath, resolveLocale } from '@/i18n/resolve-locale';
import { routing } from '@/i18n/routing';

// Выполняется перед каждым запросом страницы (в Next.js 16 файл называется proxy, раньше middleware).
// Адрес без языка или с неподдерживаемым языком перенаправляется на язык посетителя (FR-I18N-06).

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
  return withLocale(request);
}

export const config = {
  // Страницы портала. Обработчики /api, служебные адреса Next.js и файлы с расширением не затрагиваются.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
